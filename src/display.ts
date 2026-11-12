// The real displays of this machine, for a headed launch.
//
// A headed window can be dragged to any connected display and as large as it is, while
// the screen in the fingerprint is fixed at launch. A window larger than its own screen is
// impossible on a real machine: measured, dragging a launch on a spoofed 1512x982 screen
// out to a 2560x1440 monitor gave a page 2560x1325 inside a 2560x1410 window. So a headed
// launch asks for a fingerprint screen at least as large as the largest display here.
import { execFile } from "child_process";

export interface Display { width: number; height: number; availWidth: number; availHeight: number; }

let cached: Promise<Display[] | null> | null = null;

const run = (cmd: string, args: string[], timeout = 4000) => new Promise<string>((resolve, reject) =>
  execFile(cmd, args, { timeout, encoding: "utf8" }, (err, out) => err ? reject(err) : resolve(String(out))));

/** Every display, in points (what a page's screen.width means). Null when it cannot be
 *  read: no display server, a sandbox, or a platform this does not know. */
export function displays(): Promise<Display[] | null> {
  if (!cached) cached = readDisplays().catch(() => null);
  return cached;
}

async function readDisplays(): Promise<Display[] | null> {
  if (process.platform === "darwin") {
    // AppKit through JavaScript for Automation: about 0.1s, and no permission prompt.
    const out = await run("osascript", ["-l", "JavaScript", "-e",
      'ObjC.import("AppKit"); const all = $.NSScreen.screens; const out = []; for (let i = 0; i < all.count; i++) { const s = all.objectAtIndex(i); out.push({ width: s.frame.size.width, height: s.frame.size.height, availWidth: s.visibleFrame.size.width, availHeight: s.visibleFrame.size.height }); } JSON.stringify(out)']);
    return parseDisplays(out);
  }
  if (process.platform === "win32") {
    const out = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{ width = $_.Bounds.Width; height = $_.Bounds.Height; availWidth = $_.WorkingArea.Width; availHeight = $_.WorkingArea.Height } } | ConvertTo-Json -Compress"], 8000);
    const parsed = JSON.parse(out.trim() || "null");
    return parseDisplays(JSON.stringify(Array.isArray(parsed) ? parsed : parsed ? [parsed] : []));
  }
  if (process.platform === "linux") {
    const out = await run("xrandr", ["--current"]);
    const found = [...out.matchAll(/\bconnected(?: primary)? (\d+)x(\d+)\+\d+\+\d+/g)]
      .map(m => ({ width: Number(m[1]), height: Number(m[2]), availWidth: Number(m[1]), availHeight: Number(m[2]) }));
    return found.length ? found : null;
  }
  return null;
}

export function parseDisplays(json: string): Display[] | null {
  try {
    const list = JSON.parse(json);
    if (!Array.isArray(list)) return null;
    const ok = list.map((d: any) => ({ width: Math.round(+d.width), height: Math.round(+d.height), availWidth: Math.round(+d.availWidth), availHeight: Math.round(+d.availHeight) }))
      .filter(d => d.width > 0 && d.height > 0);
    return ok.length ? ok : null;
  } catch { return null; }
}

/** The smallest screen that holds every display here, so no window dragged anywhere is
 *  larger than the screen the page is told about. */
export function screenToHold(list: Display[] | null): { width: number; height: number } | null {
  if (!list || !list.length) return null;
  return { width: Math.max(...list.map(d => d.width)), height: Math.max(...list.map(d => d.height)) };
}
