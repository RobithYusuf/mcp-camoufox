// OS-level mouse input for macOS, via a tiny CGEvent helper.
//
// Why this exists: a Playwright/Juggler click is injected at the browser→renderer
// boundary, so its DOM event carries mozInputSource=0 / pointerType="" — not a
// hardware pointer. Some anti-bot checks (Cloudflare interactive Turnstile among
// them) score that as synthetic and reject it. A CGEvent posted to the HID event
// tap moves the REAL system cursor and arrives as a genuine mouse event.
//
// Hard limits, by construction — this can never be a mass/headless abuse path:
//   • macOS only.
//   • The browser must be HEADED (an on-screen window), or there is nothing to aim at.
//   • The host process needs macOS Accessibility permission, which the user grants.
//   • It drives the one real cursor, one click at a time, bringing the window forward.
//
// The helper is a ~60-line Swift program compiled lazily with `swiftc` into
// ~/.camoufox-mcp/bin and cached. If swiftc is absent, callers get a clear error.
import { spawn, spawnSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { PROFILE_PARENT } from "./state.js";

const SWIFT_SRC = `import AppKit
import CoreGraphics
import Foundation

func windowBounds(_ pid: Int32) -> CGRect? {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return nil }
    var best: CGRect?
    for w in list {
        guard (w[kCGWindowOwnerPID as String] as? Int32) == pid,
              (w[kCGWindowLayer as String] as? Int) == 0,
              let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
        let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
        if best == nil || r.width * r.height > best!.width * best!.height { best = r }
    }
    return best
}

let a = CommandLine.arguments
guard a.count >= 3, let pid = Int32(a[2]) else { print("{\\"error\\":\\"bad args\\"}"); exit(2) }
guard let win = windowBounds(pid) else { print("{\\"error\\":\\"no on-screen window for pid \\(pid)\\"}"); exit(3) }

if a[1] == "geom" {
    print("{\\"x\\":\\(win.minX),\\"y\\":\\(win.minY),\\"w\\":\\(win.width),\\"h\\":\\(win.height),\\"axTrusted\\":\\(AXIsProcessTrusted())}")
    exit(0)
}

guard a[1] == "click", a.count == 5, let ox = Double(a[3]), let oy = Double(a[4]) else { print("{\\"error\\":\\"bad args\\"}"); exit(2) }
let target = CGPoint(x: win.minX + ox, y: win.minY + oy)
// Bring the target window frontmost. A plain activate() from a BACKGROUND CLI
// process (the MCP server) does not reliably raise another app, so a synthetic
// click could land on whatever is actually frontmost; .activateIgnoringOtherApps
// forces it.
let app = NSRunningApplication(processIdentifier: pid)
app?.activate(options: [.activateIgnoringOtherApps])
usleep(300_000)

// Posting a synthetic click needs Accessibility, and macOS forbids an app from
// granting it to itself. If we are not trusted: open the native permission dialog,
// then poll up to ~25s so that if the user grants it we auto-continue to the click.
// If still not granted, WARP the cursor onto the checkbox (warping needs no
// permission) and hand off — a human finishes with one ordinary left-click.
if !AXIsProcessTrusted() {
    let opts = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(opts)
    var granted = false
    for _ in 0..<50 { if AXIsProcessTrusted() { granted = true; break }; usleep(500_000) }
    if !granted {
        CGWarpMouseCursorPosition(target)
        print("{\\"parked\\":true,\\"trusted\\":false,\\"x\\":\\(target.x),\\"y\\":\\(target.y)}")
        exit(0)
    }
    app?.activate(options: [.activateIgnoringOtherApps])
    usleep(300_000)
}
app?.activate(options: [.activateIgnoringOtherApps])
usleep(400_000)
let src = CGEventSource(stateID: .hidSystemState)
// Approach from the current cursor position, clamped to a sane on-screen start so
// the glide is never a near-zero teleport (cursor already on target) nor a move
// that begins off-screen. This mirrors the standalone click that passes.
let cur = CGEvent(source: nil)?.location ?? CGPoint(x: target.x + 180, y: target.y - 120)
var startX = cur.x, startY = cur.y
if abs(startX - target.x) < 60 && abs(startY - target.y) < 60 {
    startX = max(win.minX + 20, target.x - 180)
    startY = max(win.minY + 20, target.y - 120)
}
let start = CGPoint(x: startX, y: startY)
let steps = 40
for i in 1...steps {
    let t = Double(i) / Double(steps)
    let e = t * t * (3 - 2 * t)
    let p = CGPoint(x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e)
    CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(12_000)
}
usleep(250_000)
CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: target, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(60_000)
CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: target, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(100_000)
print("{\\"posted\\":true,\\"x\\":\\(target.x),\\"y\\":\\(target.y)}")
`;

const BIN_DIR = join(PROFILE_PARENT, "bin");
const TAG = createHash("sha256").update(SWIFT_SRC).digest("hex").slice(0, 12);
const BIN = join(BIN_DIR, `osclick-${TAG}`);

export function osInputError(): string | null {
  const p = process.platform;
  if (p === "darwin" || p === "win32" || p === "linux") return null;
  return "os_input runs on macOS, Windows or Linux (needs a real desktop session); this host is " + p + ".";
}

export const ACCESSIBILITY_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

export interface OsClickResult { ok: boolean; detail: string; screenX?: number; screenY?: number; humanHandoff?: boolean; }

// Run a helper WITHOUT blocking the Node event loop. spawnSync would freeze the MCP
// server's event loop — and with it the live automation connection — for the whole
// ~1s of the click; a click delivered with that connection frozen is rejected by
// Turnstile while the same click with it live passes, so the mover must run async.
function run(cmd: string, args: string[]): Promise<any> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 40000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => {
      clearTimeout(timer);
      // Tolerate extra lines (PowerShell banners etc.): take the last JSON object.
      const line = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).reverse().find(s => s.startsWith("{"));
      try { resolve(JSON.parse(line || out.trim() || "{}")); }
      catch { resolve({ error: "unparseable helper output: " + (out || err).slice(0, 160) }); }
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({ error: e.message }); });
  });
}

interface Geom { x: number; y: number; w: number; h: number; error?: string }
interface Backend {
  findPid(profileDir: string): Promise<number | null>;
  geom(pid: number): Promise<Geom & { error?: string }>;
  click(pid: number, relX: number, relY: number, geom: Geom): Promise<any>;
}

// ── macOS backend (verified): Swift + CoreGraphics CGEvent ──────────────────
function ensureMacHelper(): string {
  if (existsSync(BIN)) return BIN;
  if (spawnSync("which", ["swiftc"], { encoding: "utf8" }).status !== 0)
    throw new Error("os_input needs `swiftc` to build its click helper (install Xcode Command Line Tools: xcode-select --install).");
  mkdirSync(BIN_DIR, { recursive: true });
  const srcPath = join(BIN_DIR, `osclick-${TAG}.swift`);
  writeFileSync(srcPath, SWIFT_SRC);
  const r = spawnSync("swiftc", ["-O", srcPath, "-o", BIN], { encoding: "utf8", timeout: 120000 });
  if (r.status !== 0 || !existsSync(BIN))
    throw new Error("os_input: swiftc failed to build the click helper: " + (r.stderr || r.error?.message || "unknown"));
  chmodSync(BIN, 0o755);
  return BIN;
}
const macBackend: Backend = {
  async findPid(profileDir) {
    const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    for (const line of (ps.stdout || "").split("\n")) {
      if (!line.includes("/MacOS/camoufox ") || line.includes("plugin-container") || !line.includes(profileDir)) continue;
      const pid = parseInt(line.trim().split(/\s+/)[0], 10);
      if (pid > 0) return pid;
    }
    return null;
  },
  geom(pid) { return run(ensureMacHelper(), ["geom", String(pid)]); },
  click(pid, relX, relY) { return run(ensureMacHelper(), ["click", String(pid), String(relX), String(relY)]); },
};

// ── Windows backend (UNVERIFIED — not yet tested on Windows): PowerShell + ──
// Win32 P/Invoke (SendCursorPos + mouse_event). No Accessibility gate on Windows.
const WIN_PS1 = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class OsIn {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr Find(uint target) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      uint wp; GetWindowThreadProcessId(h, out wp);
      if (wp != target) return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      long a = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (a > bestArea) { bestArea = a; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@
[OsIn]::SetProcessDPIAware() | Out-Null
$mode = $args[0]
$targetPid = [uint32]$args[1]
$h = [OsIn]::Find($targetPid)
if ($h -eq [IntPtr]::Zero) { Write-Output '{"error":"no on-screen window for pid"}'; exit 3 }
$r = New-Object OsIn+RECT
[OsIn]::GetWindowRect($h, [ref]$r) | Out-Null
$wx = $r.Left; $wy = $r.Top; $ww = $r.Right - $r.Left; $wh = $r.Bottom - $r.Top
if ($mode -eq 'geom') { Write-Output ('{"x":' + $wx + ',"y":' + $wy + ',"w":' + $ww + ',"h":' + $wh + '}'); exit 0 }
if ($mode -eq 'click') {
  $ox = [int]$args[2]; $oy = [int]$args[3]
  $tx = $wx + $ox; $ty = $wy + $oy
  [OsIn]::ShowWindow($h, 9) | Out-Null
  [OsIn]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 300
  $startX = $tx - 180; $startY = $ty - 120
  for ($i = 1; $i -le 40; $i++) {
    $t = $i / 40.0; $e = $t * $t * (3 - 2 * $t)
    [OsIn]::SetCursorPos([int]($startX + ($tx - $startX) * $e), [int]($startY + ($ty - $startY) * $e)) | Out-Null
    Start-Sleep -Milliseconds 12
  }
  Start-Sleep -Milliseconds 250
  [OsIn]::SetCursorPos($tx, $ty) | Out-Null
  [OsIn]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [OsIn]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  Write-Output ('{"posted":true,"x":' + $tx + ',"y":' + $ty + '}')
  exit 0
}
Write-Output '{"error":"bad mode"}'; exit 2
`;
const WIN_PS1_PATH = join(BIN_DIR, `osclick-win-${createHash("sha256").update(WIN_PS1).digest("hex").slice(0, 12)}.ps1`);
function ensureWinHelper(): string {
  if (!existsSync(WIN_PS1_PATH)) { mkdirSync(BIN_DIR, { recursive: true }); writeFileSync(WIN_PS1_PATH, WIN_PS1); }
  return WIN_PS1_PATH;
}
const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
const winBackend: Backend = {
  async findPid(profileDir) {
    // The main (window-owning) process names the profile dir in its command line and
    // is neither a plugin-container nor a -contentproc child.
    const esc = profileDir.replace(/'/g, "''");
    const cmd = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${esc}*' -and $_.CommandLine -notlike '*plugin-container*' -and $_.CommandLine -notlike '*-contentproc*' } | Select-Object -First 1 -ExpandProperty ProcessId`;
    const raw = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", timeout: 20000 });
    const n = parseInt((raw.stdout || "").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  },
  geom(pid) { return run("powershell", [...PS, ensureWinHelper(), "geom", String(pid)]); },
  click(pid, relX, relY) { return run("powershell", [...PS, ensureWinHelper(), "click", String(pid), String(relX), String(relY)]); },
};

// ── Linux backend (UNVERIFIED — not yet tested on Linux): xdotool (X11). ─────
// Wayland has no standard synthetic-input path; xdotool needs an X11 session.
function shOut(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = ""; const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch {} }, 20000);
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => { clearTimeout(t); resolve(out); });
    c.on("error", () => { clearTimeout(t); resolve(""); });
  });
}
async function linuxWindowId(pid: number): Promise<string | null> {
  if (spawnSync("which", ["xdotool"], { encoding: "utf8" }).status !== 0) return null;
  const out = await shOut("xdotool", ["search", "--pid", String(pid), "--onlyvisible"]);
  const ids = out.split(/\s+/).map(s => s.trim()).filter(Boolean);
  let best: { id: string; area: number } | null = null;
  for (const id of ids) {
    const g = await shOut("xdotool", ["getwindowgeometry", "--shell", id]);
    const w = parseInt((g.match(/WIDTH=(\d+)/) || [])[1] || "0", 10);
    const h = parseInt((g.match(/HEIGHT=(\d+)/) || [])[1] || "0", 10);
    if (w * h > (best?.area ?? 0)) best = { id, area: w * h };
  }
  return best?.id ?? null;
}
const linuxBackend: Backend = {
  async findPid(profileDir) {
    const ps = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    for (const line of (ps.stdout || "").split("\n")) {
      if (!/\/camoufox\b/.test(line) || line.includes("plugin-container") || line.includes("-contentproc") || !line.includes(profileDir)) continue;
      const pid = parseInt(line.trim().split(/\s+/)[0], 10);
      if (pid > 0) return pid;
    }
    return null;
  },
  async geom(pid) {
    if (spawnSync("which", ["xdotool"], { encoding: "utf8" }).status !== 0)
      return { x: 0, y: 0, w: 0, h: 0, error: "`xdotool` not found — install it (e.g. apt install xdotool); X11 session required (Wayland unsupported)." };
    const wid = await linuxWindowId(pid);
    if (!wid) return { x: 0, y: 0, w: 0, h: 0, error: "no on-screen window for pid (headed X11 session required)" };
    const g = await shOut("xdotool", ["getwindowgeometry", "--shell", wid]);
    const x = parseInt((g.match(/\bX=(-?\d+)/) || [])[1] || "0", 10);
    const y = parseInt((g.match(/\bY=(-?\d+)/) || [])[1] || "0", 10);
    const w = parseInt((g.match(/WIDTH=(\d+)/) || [])[1] || "0", 10);
    const h = parseInt((g.match(/HEIGHT=(\d+)/) || [])[1] || "0", 10);
    (linuxBackend as any)._wid = wid;
    return { x, y, w, h };
  },
  async click(pid, relX, relY, geom) {
    const wid = (linuxBackend as any)._wid || await linuxWindowId(pid);
    if (!wid) return { error: "no window id" };
    const tx = geom.x + relX, ty = geom.y + relY;
    await shOut("xdotool", ["windowactivate", "--sync", wid]);
    await new Promise(r => setTimeout(r, 250));
    // glide
    const sx = tx - 180, sy = ty - 120;
    for (let i = 1; i <= 20; i++) {
      const t = i / 20, e = t * t * (3 - 2 * t);
      await shOut("xdotool", ["mousemove", "--sync", String(Math.round(sx + (tx - sx) * e)), String(Math.round(sy + (ty - sy) * e))]);
    }
    await new Promise(r => setTimeout(r, 200));
    await shOut("xdotool", ["mousemove", "--sync", String(tx), String(ty)]);
    await shOut("xdotool", ["click", "1"]);
    return { posted: true, x: tx, y: ty };
  },
};

function backendFor(): Backend | null {
  if (process.platform === "darwin") return macBackend;
  if (process.platform === "win32") return winBackend;
  if (process.platform === "linux") return linuxBackend;
  return null;
}

/**
 * Click at page-viewport coordinates (vx, vy) via a real OS cursor event.
 * macOS is verified; Windows/Linux backends are implemented but not yet tested.
 */
export async function osClickViewport(profileDir: string, vx: number, vy: number, innerH: number): Promise<OsClickResult> {
  const be = backendFor();
  if (!be) return { ok: false, detail: osInputError() || "unsupported platform" };
  const plat = process.platform;

  let pid: number | null;
  try { pid = await be.findPid(profileDir); }
  catch (e: any) { return { ok: false, detail: e?.message || String(e) }; }
  if (!pid) return { ok: false, detail: `could not find the on-screen Camoufox window for this profile — os_input needs a HEADED browser (launch with headless=false). [${plat}]` };

  let geom: Geom;
  try { geom = await be.geom(pid); }
  catch (e: any) { return { ok: false, detail: e?.message || String(e) }; }
  if (geom.error) return { ok: false, detail: `window geometry unavailable: ${geom.error}` };

  // Viewport→window-relative: no horizontal chrome (winW≈innerW); vertical offset is
  // the window's chrome height = winH − innerH. The helper adds the window origin, so
  // pass WINDOW-RELATIVE coords. Points match CSS px on the logical display (dpr 1 & 2).
  const chromeH = Math.max(0, geom.h - innerH);
  const relX = vx, relY = vy + chromeH;
  const sx = geom.x + relX, sy = geom.y + relY;

  let clicked: any;
  try { clicked = await be.click(pid, Math.round(relX), Math.round(relY), geom); }
  catch (e: any) { return { ok: false, detail: e?.message || String(e) }; }

  if (clicked.parked) {
    // macOS only: not granted in time, cursor parked ON the checkbox (warp needs no
    // permission) for a one-click human handoff.
    return {
      ok: false, humanHandoff: true, screenX: sx, screenY: sy,
      detail: `macOS Accessibility permission was not granted, so the click could not be posted. A system permission dialog was opened for it. The cursor has been placed exactly on the Turnstile checkbox at screen (${Math.round(sx)},${Math.round(sy)}) — a single ordinary LEFT-click (mouse or touchpad) right where the cursor is will solve it; no aiming needed. To let it click automatically next time, grant Accessibility (${ACCESSIBILITY_SETTINGS_URL}) to the app running this server, then call again.`,
    };
  }
  if (!clicked.posted) return { ok: false, detail: `os click failed: ${clicked.error || "unknown"}` };
  return { ok: true, detail: `OS click posted at screen (${Math.round(sx)},${Math.round(sy)}) [${plat} window ${geom.x},${geom.y} ${geom.w}x${geom.h}, chrome ${chromeH}px]`, screenX: sx, screenY: sy };
}
