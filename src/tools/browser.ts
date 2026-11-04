// Browser lifecycle, navigation, snapshot and screenshot.
//
// Registered by importing this module — see src/index.ts.
import { z } from "zod";
import { Camoufox } from "camoufox-js";
import type { BrowserContext, Page, Dialog } from "playwright-core";
import { mkdirSync } from "fs";
import { join } from "path";
import { S, PROFILE_DIR, SCREENSHOT_DIR, getPage, ensureDirs,
         consoleMessages, networkRequests, storageSnapshots, interceptLog, dialogLog } from "../state.js";
import { ACTION_TIMEOUT, safeName, ERROR_HOOK_JS, refLocator,
         snapshotPage,
         trackPage, gotoReady, waitReady, settle, historyStep } from "../helpers.js";
import { stopBrowser, removeTempProfile, tempProfilePath, sweepAbandonedTempProfiles } from "../lifecycle.js";
import { regTool } from "../server.js";

// ── Tools: Browser Lifecycle ───────────────────────────────────────────────

async function ensureCamoufoxBinary() {
  const { execSync } = await import("child_process");
  const { existsSync } = await import("fs");
  const { join: pathJoin } = await import("path");
  const os = await import("os");

  const homeDir = os.homedir();
  const platform = os.platform();
  let cacheDir: string;
  if (platform === "darwin") {
    cacheDir = pathJoin(homeDir, "Library", "Caches", "camoufox");
  } else if (platform === "win32") {
    cacheDir = pathJoin(process.env.LOCALAPPDATA || pathJoin(homeDir, "AppData", "Local"), "camoufox");
  } else {
    cacheDir = pathJoin(process.env.XDG_CACHE_HOME || pathJoin(homeDir, ".cache"), "camoufox");
  }
  const versionFile = pathJoin(cacheDir, "version.json");
  if (existsSync(versionFile)) return;

  console.error("\n" + "=".repeat(60));
  console.error("[mcp-camoufox] First-time setup: downloading Camoufox (~500MB)");
  console.error("[mcp-camoufox] Please wait 2-5 minutes...");
  console.error("=".repeat(60) + "\n");
  const cmd = platform === "win32" ? "npx.cmd" : "npx";
  // CRITICAL: redirect child stdout → parent stderr.
  // stdio:'inherit' would pollute MCP JSON-RPC stdout channel with download
  // progress text, causing client parse errors like:
  //   "invalid character 'C' looking for beginning of value"
  // (issue #1: 'C' = first byte of "Camoufox..." progress message).
  execSync(`${cmd} camoufox-js fetch`, {
    stdio: ["ignore", 2, 2], timeout: 900000,
    env: { ...process.env, npm_config_yes: "true" },
  });
  console.error("\n[mcp-camoufox] Download complete.\n");
}

// Forget the browser. Everything a session holds lives here, so close, recover and an
// unexpected exit cannot each forget something different.
export function resetBrowserState(): void {
  S.browserContext = null;
  S.pages = [];
  S.activePage = 0;
  S.browserUp = false;
  S.activeProfileDir = null;
  S.activeProfileIsTemp = false;
  consoleMessages.length = 0;
  networkRequests.length = 0;
  S.networkSeq = 0;
  S.networkCaptureBodies = false;
  S.networkHandler = null;
  S.consoleHandler = null;
  S.autoDialogCfg = null;
  S.oneShotDialog = null;
  S.interceptHandler = null; S.interceptBlocked = 0; S.interceptAllowed = 0;
  interceptLog.length = 0;
  dialogLog.length = 0;
  storageSnapshots.clear();
}

/** Stop the current browser and remove its temp profile only once it is gone. */
export async function stopCurrentBrowser(): Promise<{ verified: boolean; alive: number[]; forced: boolean; tempNote: string }> {
  const ctx = S.browserContext, dir = S.activeProfileDir, isTemp = S.activeProfileIsTemp;
  S.stopping = true;
  try {
    const res = await stopBrowser(ctx, dir);
    let tempNote = "";
    if (isTemp && dir) {
      if (res.alive.length) tempNote = `Temp profile kept at ${dir}: the browser is still running on it.`;
      else {
        const problem = removeTempProfile(dir);
        tempNote = problem ? `Temp profile NOT removed (${dir}): ${problem}` : `Temp profile removed (${dir}).`;
      }
    }
    return { ...res, tempNote };
  } finally {
    resetBrowserState();
    S.stopping = false;
  }
}

/** Used when the server itself is going away. */
export async function shutdownBrowser(): Promise<void> {
  if (S.browserContext) await stopCurrentBrowser();
}

regTool(
  "browser_launch",
  "Launch Camoufox stealth browser and navigate to URL. Browser persists between calls. " +
    "By default cookies/localStorage persist in ~/.camoufox-mcp/profile. " +
    "Set fresh_profile=true to start with a clean temp profile (auto-cleaned on browser_close) — " +
    "useful when switching between accounts on the same domain.",
  {
    url: z.string().default("about:blank").describe("URL to navigate to"),
    headless: z.boolean().default(true).describe("Run without visible window"),
    humanize: z.boolean().default(false).describe("Human-like mouse movements"),
    geoip: z.boolean().default(true).describe("Auto-detect timezone from IP"),
    locale: z.string().default("en-US").describe("Browser locale"),
    width: z.number().default(0).describe("WINDOW width (0 = default 1280). The viewport matches this width and is 80px shorter than the window height (browser chrome) — use set_viewport_size to set a viewport independently of the window."),
    height: z.number().default(0).describe("WINDOW height (0 = default 800). See width."),
    no_viewport: z.boolean().default(false).describe(
      "Let the content area follow the real OS window instead of a fixed viewport (Playwright viewport:null). " +
      "WARNING: this drops the window-size cap, so the viewport can end up LARGER than the spoofed screen — " +
      "a window wider than its own screen is an easy anti-bot tell. Prefer set_viewport_size unless you need a full-window canvas."),
    fresh_profile: z.boolean().default(false).describe(
      "Start with a clean temp profile (no carry-over cookies/cache). " +
      "Temp dir is removed when browser_close is called. " +
      "Use when switching between accounts on the same domain to avoid login session collisions."
    ),
  },
  async ({ url, headless, humanize, geoip, locale, width, height, fresh_profile, no_viewport }) => {
    // Wait out a launch already in progress, then fall through to the
    // already-running path rather than building a second context.
    if (S.launchInFlight) { try { await S.launchInFlight; } catch {} }
    if (S.browserUp && S.browserContext) {
      // Every tab was closed. The browser is still alive, so open a tab in it: starting
      // a second one on the same profile would fail, and getPage here used to answer
      // "call browser_launch first" from inside browser_launch, for ever.
      if (S.pages.length === 0) {
        const fresh = await S.browserContext.newPage();
        trackPage(fresh);
        S.activePage = S.pages.indexOf(fresh);
      }
      const page = getPage();
      if (url && url !== "about:blank") {
        await gotoReady(page, url, "domcontentloaded", 30000);
        await settle(page, 1500);
      }
      return { content: [{ type: "text", text: `Already running — launch options (headless/humanize/geoip/locale/size/fresh_profile) were IGNORED; call browser_close first to relaunch with new options. Navigated to: ${page.url()}` }] };
    }

    // Claim the launch slot with no await in between, so a second concurrent
    // call cannot slip past the guard above and build a second context.
    let releaseLaunch: () => void = () => {};
    S.launchInFlight = new Promise<void>(res => { releaseLaunch = res; });
    try {
    ensureDirs();
    const w = width > 0 ? width : 1280;
    const h = height > 0 ? height : 800;

    // Pick profile dir: fresh temp dir or shared persistent
    let profileDir = PROFILE_DIR;
    let isTemp = false;
    // A crashed server cannot clean up after itself, so the next launch does.
    sweepAbandonedTempProfiles();
    if (fresh_profile) {
      profileDir = tempProfilePath();
      mkdirSync(profileDir, { recursive: true });
      isTemp = true;
    }

    await ensureCamoufoxBinary();

    let ctx: BrowserContext;
    try {
      ctx = await Camoufox({
        headless,
        humanize,
        geoip,
        locale,
        user_data_dir: profileDir,
        disable_coop: true,
        // no_viewport: let the content follow the real window. We also drop the
        // fixed `window` size then — pinning both is what produced a 1280x749
        // content area that still didn't fill the frame.
        // Size the viewport WITH the window. Passing `window` alone left Playwright's
        // default 1280x720 viewport in place, so browser_launch(width=1400) produced
        // outerWidth 1400 with innerWidth 1280 — 120px of horizontal chrome, which no
        // real Firefox has. Any site can subtract those two and see it. The 80px is
        // the measured vertical chrome, so the default 1280x800 window keeps giving
        // exactly the 1280x720 viewport it always did.
        ...(no_viewport
          ? { viewport: null }
          : { window: [w, h] as [number, number], viewport: { width: w, height: Math.max(200, h - 80) } }),
        i_know_what_im_doing: true,
        // Playwright starts a headed Firefox with -foreground, which pulls the window
        // to the front and takes the keyboard from whatever the developer is typing in.
        ...(headless ? {} : { ignoreDefaultArgs: ["-foreground"] }),
        // index.ts closes the browser and removes a temp profile on these. Playwright's
        // own handlers would race it and could exit first.
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        firefox_user_prefs: {
          "permissions.default.desktop-notification": 2,
          "dom.webnotifications.enabled": false,
          "browser.translations.automaticallyPopup": false,
          // camoufox.cfg sets this to 0, which turns history off: goBack answers null
          // and history.back() does nothing, even over a pushState entry. 50 is stock
          // Firefox's own value.
          "browser.sessionhistory.max_entries": 50,
          // Lets navigator.clipboard.writeText work without a user gesture, so
          // paste_text can deliver a REAL (trusted) paste event. Firefox refuses
          // to attach clipboardData to a synthetic ClipboardEvent, so without
          // this a paste-only framework field can never be filled.
          "dom.events.testing.asyncClipboard": true,
        },
      } as any) as BrowserContext;
    } catch (e) {
      // Leave nothing behind from a launch that failed, unless a process somehow
      // still holds the folder.
      await stopBrowser(null, profileDir).catch(() => {});
      if (isTemp) removeTempProfile(profileDir);
      throw e;
    }

    S.browserContext = ctx;
    S.lastExitNote = "";
    // Locator calls without their own timeout default to 30s, half of what most MCP
    // clients allow, for an answer that is nearly always "that element is not there".
    ctx.setDefaultTimeout(10000);
    // The browser can go away without a tool asking: a crash, a kill, the user quitting
    // it. Without this, browser_up stayed true and browser_launch refused for ever.
    ctx.on("close", () => {
      if (S.stopping || S.browserContext !== ctx) return;
      const dir = S.activeProfileDir, temp = S.activeProfileIsTemp;
      resetBrowserState();
      S.lastExitNote = "The last browser exited unexpectedly (it crashed or was closed from outside).";
      if (temp && dir) removeTempProfile(dir);
    });
    // Page-error hook must be installed before the first navigation so
    // get_page_errors has something to read (it runs on every page load).
    try { await ctx.addInitScript(ERROR_HOOK_JS); } catch {}
    S.activeProfileDir = profileDir;
    S.activeProfileIsTemp = isTemp;
    S.pages = [];
    S.activePage = 0;
    S.browserUp = true;
    // Track pages the site opens itself (window.open / target=_blank), not just
    // tabs we create — otherwise popup/OAuth windows are invisible to all tools.
    ctx.on("page", (p) => trackPage(p));
    const existingPages = ctx.pages();
    const page = existingPages.length > 0 ? existingPages[0] : await ctx.newPage();
    trackPage(page);
    S.activePage = S.pages.indexOf(page);
    if (S.activePage < 0) S.activePage = 0;

    // Camoufox picks the spoofed screen itself, and it is often smaller than the
    // size a caller asks for — a 1400-wide launch landed on a spoofed 1366x768
    // screen, leaving the viewport wider than the display it claims to be on.
    // No real window can do that, so fit the viewport to the screen rather than
    // hand the caller a fingerprint tell they never asked for.
    let clampNote = "";
    if (!no_viewport) {
      try {
        const scr = JSON.parse(await page.evaluate(
          `(() => JSON.stringify({ w: screen.width, h: screen.height }))()`) as string);
        const vp = page.viewportSize();
        if (vp && scr.w && scr.h && (vp.width > scr.w || vp.height > scr.h)) {
          const fitted = { width: Math.min(vp.width, scr.w), height: Math.min(vp.height, Math.max(200, scr.h - 80)) };
          await page.setViewportSize(fitted);
          clampNote = `\n⚠ Requested ${vp.width}x${vp.height}, but Camoufox spoofed a ${scr.w}x${scr.h} screen for this profile.`
            + ` The viewport was reduced to ${fitted.width}x${fitted.height} — a viewport larger than its own screen is an anti-bot tell.`
            + ` The WINDOW is still ${vp.width} wide and cannot be resized after launch, so a large request leaves its own mismatch:`
            + ` relaunch at a size near ${scr.w}x${scr.h} for a clean fingerprint, or pass no_viewport=true to opt out of this fit.`
            + ` Run fingerprint_audit to see what the page actually reports.`;
        }
      } catch {}
    }

    if (url && url !== "about:blank") {
      try {
        await gotoReady(page, url, "domcontentloaded", 30000);
        await settle(page, 1500);
      } catch (e: any) {
        // Worth a distinct reply: the launch itself worked and the browser is running,
        // so the caller should navigate again rather than launch again.
        return { content: [{ type: "text", text: `The browser launched and is running, but the first navigation failed: ${String(e?.message || e)}\nCall navigate to try another URL, or browser_close to stop it.` }], isError: true };
      }
    }
    const title = await page.title();
    const profileNote = isTemp ? " (fresh temp profile)" : "";
    // Report window vs viewport vs screen: the 80px gap is browser chrome, and a
    // viewport wider than the spoofed screen is a fingerprint tell worth seeing.
    let geom = "";
    try {
      const g: any = await page.evaluate(
        `(() => ({ iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight, sw: screen.width, sh: screen.height }))()`);
      geom = `\nViewport: ${g.iw}x${g.ih}  Window: ${g.ow}x${g.oh}  Screen: ${g.sw}x${g.sh}`;
      if (g.iw > g.sw || g.ih > g.sh) {
        geom += `\n⚠ Viewport is larger than the spoofed screen — a window bigger than its own display is an anti-bot tell. Shrink it with set_viewport_size, or relaunch without no_viewport.`;
      }
      geom += clampNote;
      geom += `\n(Viewport is shorter than the window by the 80px of browser chrome.`
        + ` Dragging the window bigger will NOT reflow the page — a fixed viewport never follows the OS window,`
        + ` so you get empty space instead. Call set_viewport_size(w,h) after resizing, or relaunch with`
        + ` no_viewport=true to let the content track the window live.)`;
    } catch {}
    return { content: [{ type: "text", text: `Browser launched${profileNote}. URL: ${page.url()}\nTitle: ${title}${geom}` }] };
    } finally {
      releaseLaunch();
      S.launchInFlight = null;
    }
  }
);

regTool(
  "browser_close",
  "Close the browser. Cookies are preserved in the persistent profile (~/.camoufox-mcp/profile). " +
    "If the launch used fresh_profile=true, the temp profile is removed.",
  {},
  async () => {
    if (!S.browserContext) {
      return { content: [{ type: "text", text: "No browser is running, so there is nothing to close." }] };
    }
    const isTemp = S.activeProfileIsTemp;
    // Say what actually persists. "Profile saved" alone was misleading: session
    // cookies (no expiry) live in memory and die here, which reads as "the
    // profile lost my login".
    let cookieNote = "";
    try {
      const cookies = await Promise.race([
        S.browserContext.cookies(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
      ]);
      const session = cookies.filter((c: any) => !c.expires || c.expires <= 0).length;
      const persisted = cookies.length - session;
      cookieNote = ` Cookies: ${persisted} persisted, ${session} session-only (dropped — standard browser behaviour; use cookie_set(expires_days=…) or storage_state_save to keep a login).`;
    } catch {}
    const res = await stopCurrentBrowser();
    // "Closed" is a claim about a process, so it is only made after looking.
    if (res.alive.length) {
      return { content: [{ type: "text", text: `The browser did NOT exit: pid ${res.alive.join(", ")} is still running on the profile. ${res.tempNote}` }], isError: true };
    }
    const proof = res.verified
      ? `Process exit verified${res.forced ? " (it had to be stopped with a signal)" : ""}.`
      : "Process exit could NOT be verified on this platform.";
    return { content: [{ type: "text", text: `Browser closed. ${proof} ${isTemp ? res.tempNote : `Profile saved.${cookieNote}`}` }] };
  }
);

regTool(
  "reset_profile",
  "Delete the persistent profile (~/.camoufox-mcp/profile) entirely. " +
    "Use to start fresh — cookies, localStorage, history all wiped. " +
    "Browser must be closed first (call browser_close before this).",
  {},
  async () => {
    if (S.browserUp) {
      return {
        content: [{
          type: "text",
          text: "Refused: browser is running. Call browser_close first, then reset_profile.",
        }],
        isError: true,
      };
    }
    try {
      const { rmSync, existsSync } = await import("fs");
      if (existsSync(PROFILE_DIR)) {
        rmSync(PROFILE_DIR, { recursive: true, force: true });
        return { content: [{ type: "text", text: `Profile wiped: ${PROFILE_DIR}` }] };
      }
      return { content: [{ type: "text", text: "Profile dir did not exist — nothing to wipe." }] };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Failed to wipe profile: ${e?.message || e}` }],
        isError: true,
      };
    }
  }
);

// ── Tools: Navigation ──────────────────────────────────────────────────────

regTool(
  "navigate",
  "Navigate to a URL.",
  {
    url: z.string().describe("URL to navigate to"),
    wait_until: z.enum(["domcontentloaded", "load", "networkidle"]).default("domcontentloaded"),
    timeout: z.number().default(30000),
  },
  async ({ url, wait_until, timeout }) => {
    const page = getPage();
    await gotoReady(page, url, wait_until, timeout);
    await settle(page, 1000);
    return { content: [{ type: "text", text: `Navigated to: ${page.url()}\nTitle: ${await page.title()}` }] };
  }
);

regTool("go_back", "Navigate back in history. Fails when the page does not move.", {}, async () => {
  const page = getPage();
  const { moved, url } = await historyStep(page, "back", 15000);
  if (!moved) return { content: [{ type: "text", text: `Did not go back: no previous page in this tab's history. URL: ${url}` }], isError: true };
  return { content: [{ type: "text", text: `Went back. URL: ${url}` }] };
});

regTool("go_forward", "Navigate forward in history. Fails when the page does not move.", {}, async () => {
  const page = getPage();
  const { moved, url } = await historyStep(page, "forward", 15000);
  if (!moved) return { content: [{ type: "text", text: `Did not go forward: no next page in this tab's history. URL: ${url}` }], isError: true };
  return { content: [{ type: "text", text: `Went forward. URL: ${url}` }] };
});

regTool("reload", "Reload the current page.", {}, async () => {
  const page = getPage();
  await page.reload({ waitUntil: "commit", timeout: 15000 });
  await waitReady(page, "domcontentloaded", 15000);
  return { content: [{ type: "text", text: `Reloaded. URL: ${page.url()}` }] };
});

// ── Tools: Snapshot & Screenshot ───────────────────────────────────────────

regTool(
  "browser_snapshot",
  "Get visible interactive elements with ref IDs. Use refs with click/fill. Always call after navigation. " +
    'On large pages (Outlook, dashboards) the response can be truncated — narrow with roles=["button","textbox"] ' +
    "or paginate with offset/limit. Refs stay stable regardless of filters (every visible element is still numbered).",
  {
    roles: z.array(z.string()).default([]).describe('Only show elements matching these tags/roles/types, e.g. ["button","link","textbox","tab"]. Empty = all.'),
    offset: z.number().default(0).describe("Skip the first N matched elements (pagination)."),
    limit: z.number().default(0).describe("Max elements to return (0 = no cap)."),
  },
  async ({ roles, offset, limit }) => {
    const page = getPage();
    const text = await snapshotPage(page, { roles, offset, limit });
    return { content: [{ type: "text", text }] };
  }
);

regTool(
  "screenshot",
  "Screenshot the page, or a single element with ref/selector (great for documenting one modal). " +
    "Returns the IMAGE inline — no second Read call — plus the saved path. Set return_image=false for path only.",
  {
    name: z.string().default("page").describe("Filename prefix"),
    full_page: z.boolean().default(false).describe("Full scrollable page (ignored when ref/selector is set)"),
    ref: z.string().default("").describe("Snapshot ref — capture just that element."),
    selector: z.string().default("").describe("CSS selector — capture just that element (ignored if ref is set)."),
    return_image: z.boolean().default(true).describe("Embed the PNG in the response. false = only save to disk."),
  },
  async ({ name, full_page, ref, selector, return_image }) => {
    const page = getPage();
    const path = join(SCREENSHOT_DIR, `${safeName(name, "page")}.png`);
    let buf: Buffer;
    let what = full_page ? "full page" : "viewport";
    if (ref || selector) {
      const loc = ref ? refLocator(page, ref) : page.locator(selector).first();
      if (await loc.count() === 0) {
        return { content: [{ type: "text", text: `No element for ${ref ? `ref=${ref}` : `selector=${selector}`} — nothing to capture.` }], isError: true };
      }
      try { await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT }); } catch {}
      buf = await loc.screenshot({ path, timeout: 15000 });
      what = ref ? `element ref=${ref}` : `element ${selector}`;
    } else {
      buf = await page.screenshot({ path, fullPage: full_page });
    }
    const info = `Screenshot (${what}) saved: ${path}\nURL: ${page.url()}  (${Math.round(buf.length / 1024)} KB)`;
    // Very large captures (long full_page shots) stay on disk only — an
    // oversized inline payload is worse than a path.
    const MAX_INLINE = 6_000_000;
    if (!return_image || buf.length > MAX_INLINE) {
      const why = return_image ? " — too large to inline, read the file if you need to see it" : "";
      return { content: [{ type: "text", text: info + why }] };
    }
    return {
      content: [
        { type: "image", data: buf.toString("base64"), mimeType: "image/png" },
        { type: "text", text: info },
      ],
    };
  }
);
