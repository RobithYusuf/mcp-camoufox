// Browser lifecycle, navigation, snapshot and screenshot.
//
// Registered by importing this module — see src/index.ts.
import { z } from "zod";
import { Camoufox } from "camoufox-js";
import type { BrowserContext, Page, Dialog } from "playwright-core";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { S, PROFILE_DIR, PROFILE_PARENT, SCREENSHOT_DIR, getPage, ensureDirs,
         consoleMessages, networkRequests, storageSnapshots } from "../state.js";
import { ACTION_TIMEOUT, safeName, ERROR_HOOK_JS, refLocator,
         snapshotPage,
         trackPage, gotoReady, waitReady } from "../helpers.js";
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
      const page = getPage();
      if (url && url !== "about:blank") {
        await gotoReady(page, url, "domcontentloaded", 30000);
        await page.waitForTimeout(1500);
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
    if (fresh_profile) {
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      profileDir = join(PROFILE_PARENT, `profile-fresh-${ts}-${rand}`);
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
        firefox_user_prefs: {
          "permissions.default.desktop-notification": 2,
          "dom.webnotifications.enabled": false,
          "browser.translations.automaticallyPopup": false,
          // Lets navigator.clipboard.writeText work without a user gesture, so
          // paste_text can deliver a REAL (trusted) paste event. Firefox refuses
          // to attach clipboardData to a synthetic ClipboardEvent, so without
          // this a paste-only framework field can never be filled.
          "dom.events.testing.asyncClipboard": true,
        },
      }) as BrowserContext;
    } catch (e) {
      // Don't leak the freshly-created temp profile dir if launch failed.
      if (isTemp) { try { rmSync(profileDir, { recursive: true, force: true }); } catch {} }
      throw e;
    }

    S.browserContext = ctx;
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

    if (url && url !== "about:blank") {
      await gotoReady(page, url, "domcontentloaded", 30000);
      await page.waitForTimeout(1500);
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
    // Say what actually persists. "Profile saved" alone was misleading: session
    // cookies (no expiry) live in memory and die here, which reads as "the
    // profile lost my login".
    let cookieNote = "";
    if (S.browserContext) {
      try {
        const cookies = await S.browserContext.cookies();
        const session = cookies.filter((c: any) => !c.expires || c.expires <= 0).length;
        const persisted = cookies.length - session;
        cookieNote = ` Cookies: ${persisted} persisted, ${session} session-only (dropped — standard browser behaviour; use cookie_set(expires_days=…) or storage_state_save to keep a login).`;
      } catch {}
    }
    if (S.browserContext) {
      try { await S.browserContext.close(); } catch {}
    }
    let note = "Profile saved." + cookieNote;
    if (S.activeProfileIsTemp && S.activeProfileDir) {
      try {
        rmSync(S.activeProfileDir, { recursive: true, force: true });
        note = `Temp profile removed (${S.activeProfileDir}).`;
      } catch (e: any) {
        note = `Profile saved. Warning: failed to remove temp profile: ${e?.message || e}`;
      }
    }
    S.browserContext = null;
    S.pages = [];
    S.activePage = 0;
    S.browserUp = false;
    S.activeProfileDir = null;
    S.activeProfileIsTemp = false;
    // Reset capture state so a later launch doesn't read stale cross-session
    // data and the handlers don't pin closed page objects.
    consoleMessages.length = 0;
    networkRequests.length = 0;
    S.networkSeq = 0;
    S.networkCaptureBodies = false;
    S.networkHandler = null;
    S.consoleHandler = null;
    S.autoDialogHandler = null;
    S.autoDialogCfg = null;
    S.oneShotDialogArmed = false;
    S.oneShotDialogHandler = null;
    S.interceptHandler = null; S.interceptBlocked = 0; S.interceptAllowed = 0;
    storageSnapshots.clear();
    return { content: [{ type: "text", text: `Browser closed. ${note}` }] };
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
    await page.waitForTimeout(1000);
    return { content: [{ type: "text", text: `Navigated to: ${page.url()}\nTitle: ${await page.title()}` }] };
  }
);

regTool("go_back", "Navigate back in history.", {}, async () => {
  const page = getPage();
  await page.goBack({ waitUntil: "commit", timeout: 15000 });
  await waitReady(page, "domcontentloaded", 15000);
  return { content: [{ type: "text", text: `Went back. URL: ${page.url()}` }] };
});

regTool("go_forward", "Navigate forward in history.", {}, async () => {
  const page = getPage();
  await page.goForward({ waitUntil: "commit", timeout: 15000 });
  await waitReady(page, "domcontentloaded", 15000);
  return { content: [{ type: "text", text: `Went forward. URL: ${page.url()}` }] };
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
