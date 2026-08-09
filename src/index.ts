#!/usr/bin/env node
/**
 * MCP Camoufox — Stealth browser automation MCP server.
 *
 * Chrome DevTools MCP-level power with Camoufox anti-detection.
 * 39 tools: navigate, click, fill, type, screenshot, snapshot, tabs,
 * cookies, JS eval, scroll, keyboard, dialog, file upload, network/console.
 *
 * Install:  npm install -g mcp-camoufox
 * Usage:    claude mcp add camoufox -- npx -y mcp-camoufox
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Camoufox } from "camoufox-js";
import type { BrowserContext, Page, Dialog } from "playwright-core";

// ── Global State ───────────────────────────────────────────────────────────

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "";
const PROFILE_DIR = `${HOME_DIR}/.camoufox-mcp/profile`;
const PROFILE_PARENT = `${HOME_DIR}/.camoufox-mcp`;
const SCREENSHOT_DIR = `${HOME_DIR}/.camoufox-mcp/screenshots`;

let browserContext: BrowserContext | null = null;
let pages: Page[] = [];
let activePage = 0;
let browserUp = false;
// Tracks the profile dir used by the current launch — temp dir if fresh_profile=true,
// PROFILE_DIR otherwise. Cleaned on close when temp.
let activeProfileDir: string | null = null;
let activeProfileIsTemp = false;

function getPage(): Page {
  if (!browserUp || pages.length === 0) {
    throw new Error("Browser not running. Call browser_launch first.");
  }
  if (activePage >= pages.length) activePage = 0;
  return pages[activePage];
}

// ── Helpers ────────────────────────────────────────────────────────────────

import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { createHmac } from "crypto";
import { createRequire } from "module";

// Real package version — read at runtime so the MCP handshake never drifts from
// package.json (npm always ships package.json next to dist/).
const PKG_VERSION: string = (() => {
  try { return createRequire(import.meta.url)("../package.json").version || "0.0.0"; }
  catch { return "0.0.0"; }
})();

// Shared default timeout for element actions (click/fill/check/etc.).
const ACTION_TIMEOUT = 5000;

function ensureDirs() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// Safely embed a JS string literal inside an evaluate() source string. Manual
// quote-escaping breaks on backslashes/newlines/quotes; JSON.stringify doesn't.
function jsStr(s: string): string {
  return JSON.stringify(s ?? "");
}

// Expand a leading ~ only (a bare .replace("~", HOME) would rewrite a tilde
// anywhere in the path, e.g. "/tmp/a~b.json").
function expandHome(p: string): string {
  if (p === "~") return HOME_DIR;
  if (p.startsWith("~/")) return HOME_DIR + p.slice(1);
  return p;
}

// Expand ~, create the parent directory, return the absolute target path.
function resolveOutPath(p: string): string {
  const target = expandHome(p);
  const dir = target.substring(0, target.lastIndexOf("/"));
  if (dir) mkdirSync(dir, { recursive: true });
  return target;
}

// Runs before every page script on every navigation — populates the buffer that
// get_page_errors reads. Without this the tool always returned [].
const ERROR_HOOK_JS = `(() => {
  if (window.__mcp_errors) return;
  window.__mcp_errors = [];
  var push = function (e) { if (window.__mcp_errors.length < 100) window.__mcp_errors.push(e); };
  window.addEventListener('error', function (ev) {
    push({
      type: 'error',
      message: String(ev.message || '').slice(0, 300),
      source: String(ev.filename || '').slice(0, 200),
      line: ev.lineno || 0,
      col: ev.colno || 0,
      stack: ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 500) : '',
    });
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    push({
      type: 'unhandledrejection',
      message: String((r && (r.message || r)) || '').slice(0, 300),
      stack: r && r.stack ? String(r.stack).slice(0, 500) : '',
    });
  });
})()`;

// Base32 decode (RFC 4648) — for TOTP secrets used by login_classic
function base32Decode(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

// RFC 6238 TOTP (SHA1, 30s step, 6 digits) — no external dep
function totpFromSecret(secret: string, step = 30, digits = 6): string {
  const key = base32Decode(secret);
  let counter = Math.floor(Date.now() / 1000 / step);
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) { buf[i] = counter & 0xff; counter = Math.floor(counter / 256); }
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, "0");
}

// Click a locator, falling back to synthetic events when Playwright's
// actionability check fails (overlay, moving element, portal that just mounted).
//
// Returns which path was used so callers can SAY SO. The old version fell back
// to a bare el.click() and still reported "Clicked" — pointer-driven widgets
// (Radix, Headless UI, MUI) ignore that entirely, so a blocked click looked
// successful while nothing happened. The fallback now replays the full pointer
// sequence, and the mode is surfaced to the caller either way.
type ClickMode = "real" | "fallback";
async function clickWithFallback(
  loc: any,
  opts?: { button?: "left" | "right" | "middle"; dblclick?: boolean },
): Promise<ClickMode> {
  const button = opts?.button || "left";
  try {
    if (opts?.dblclick) await loc.dblclick({ button, timeout: ACTION_TIMEOUT });
    else await loc.click({ button, timeout: ACTION_TIMEOUT });
    return "real";
  } catch {
    await loc.evaluate((el: any) => {
      const r = el.getBoundingClientRect();
      const base: any = {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true,
      };
      const PE = (window as any).PointerEvent || MouseEvent;
      el.dispatchEvent(new PE("pointerover", { ...base, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseover", { ...base, buttons: 0 }));
      el.dispatchEvent(new PE("pointerdown", { ...base, buttons: 1 }));
      el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
      if (typeof el.focus === "function") { try { el.focus(); } catch {} }
      el.dispatchEvent(new PE("pointerup", { ...base, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
      // el.click() (not a synthetic click event) so default actions — anchor
      // navigation, form submit, label activation — still happen.
      if (typeof el.click === "function") el.click();
    }, undefined, { timeout: ACTION_TIMEOUT });
    return "fallback";
  }
}

// Suffix appended to every click result so a degraded click is never silent.
function clickNote(mode: ClickMode): string {
  return mode === "real"
    ? ""
    : " ⚠ real mouse click was blocked (overlay / actionability) — used synthetic pointer-event fallback. VERIFY the effect; if the widget ignores it, dismiss the blocker first or use mouse_click_xy.";
}

// Fill that really REPLACES the existing value.
// Playwright's fill() types into "text-like" inputs after a select-all. In
// Camoufox/Firefox that select-all is a no-op on input[type=email] and
// input[type=number] (Firefox restricts the selection APIs on those types), so a
// fill over a non-empty field APPENDS — e.g. re-filling an email field yields
// "old@x.comnew@x.com". Clearing first makes fill deterministic for every type.
async function fillLocator(loc: any, value: string): Promise<void> {
  try {
    await loc.evaluate((el: any) => {
      if (el && typeof el.value === "string" && el.value !== "") {
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, undefined, { timeout: ACTION_TIMEOUT });
  } catch {}
  await loc.fill(value, { timeout: ACTION_TIMEOUT });
}

// Locator for a snapshot ref (data-mcp-ref). Centralizes the selector so the
// ref scheme lives in exactly one place.
function refLocator(page: Page, ref: string) {
  return page.locator(`[data-mcp-ref="${ref}"]`).first();
}

// Search root for text/role/label lookups, so a click can be confined to the
// dialog the user is actually looking at instead of matching the whole page.
//   ""        → whole page
//   "@dialog" → topmost visible dialog/modal
//   "ref:e5"  → a snapshot ref
//   otherwise → CSS selector
function scopeRoot(page: Page, within?: string): any {
  const w = (within || "").trim();
  if (!w) return page;
  if (w === "@dialog") {
    return page.locator('[role="dialog"], dialog[open], [aria-modal="true"]').filter({ visible: true }).last();
  }
  if (w.startsWith("ref:")) return refLocator(page, w.slice(4));
  return page.locator(w).first();
}

// Tag up to `cap` matches with fresh refs and describe each (tag, text, ancestor
// path). Used to answer "which one did you mean?" instead of guessing.
async function describeMatches(loc: any, cap = 8): Promise<{ total: number; items: any[] }> {
  const all = await loc.all();
  const items: any[] = [];
  for (let i = 0; i < Math.min(all.length, cap); i++) {
    const info = await all[i].evaluate((el: any, idx: number) => {
      const ref = "m" + Date.now().toString(36) + "_" + idx;
      el.setAttribute("data-mcp-ref", ref);
      const parts: string[] = [];
      let e: any = el;
      for (let d = 0; e && d < 4; d++, e = e.parentElement) {
        let s = e.tagName ? e.tagName.toLowerCase() : "?";
        if (e.id) s += "#" + e.id;
        else if (e.getAttribute && e.getAttribute("role")) s += "[role=" + e.getAttribute("role") + "]";
        else if (typeof e.className === "string" && e.className.trim()) s += "." + e.className.trim().split(/\s+/)[0];
        parts.unshift(s);
      }
      const r = el.getBoundingClientRect();
      return {
        ref, index: idx,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        text: (el.innerText || el.value || "").trim().slice(0, 60),
        path: parts.join(" > "),
        visible: r.width > 0 && r.height > 0,
        at: `${Math.round(r.x)},${Math.round(r.y)}`,
      };
    }, i, { timeout: ACTION_TIMEOUT }).catch(() => null);
    if (info) items.push(info);
  }
  return { total: all.length, items };
}

function candidateList(total: number, items: any[]): string {
  const lines = items.map(c =>
    `  index=${c.index} ref=${c.ref}  [${c.tag}${c.role ? ` role=${c.role}` : ""}] "${c.text}"  at ${c.at}${c.visible ? "" : " (hidden)"}\n      in: ${c.path}`);
  const more = total > items.length ? `\n  … ${total - items.length} more` : "";
  return lines.join("\n") + more;
}

// Track a page in the global pages[] list and auto-remove it on close.
// Used for the initial page, tab_new, AND pages opened by the site itself
// (window.open / target=_blank) via the browserContext "page" event — without
// this, popup/OAuth windows are invisible to every tool. Idempotent.
// If console/network capture is active, the new page inherits the handlers so
// capture follows the user across tabs and popups.
function trackPage(p: Page): void {
  if (pages.includes(p)) return;
  pages.push(p);
  if (consoleHandler) p.on("console", consoleHandler);
  if (networkHandler) p.on("response", networkHandler);
  // A persistent dialog handler must cover tabs the site opens later too,
  // otherwise a popup's confirm() hangs the flow.
  if (autoDialogHandler) p.on("dialog", autoDialogHandler);
  p.once("close", () => {
    const i = pages.indexOf(p);
    if (i < 0) return;
    // Preserve which page is active by IDENTITY, not index — removing a
    // lower-indexed page (e.g. a popup that closed itself) must not silently
    // shift activePage onto a different tab.
    const activeObj = pages[activePage];
    pages.splice(i, 1);
    const reFound = pages.indexOf(activeObj);
    activePage = reFound >= 0 ? reFound : Math.min(activePage, pages.length - 1);
    if (activePage < 0) activePage = 0;
  });
}

// DOM snapshot JS — IIFE so page.evaluate runs it immediately
const SNAPSHOT_JS = `(() => {
  var sels = 'button, a, input:not([type="hidden"]), textarea, select, '
    + '[role="button"], [role="link"], [role="textbox"], [role="checkbox"], '
    + '[role="radio"], [role="tab"], [role="menuitem"], [contenteditable="true"], '
    + 'img[alt], h1, h2, h3, h4, h5, h6, label, [role="dialog"], [role="alert"], [role="status"]';
  var els = document.querySelectorAll(sels);
  var results = [];
  var refId = 0;
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    var ref = 'e' + refId++;
    el.setAttribute('data-mcp-ref', ref);
    var entry = {
      ref: ref,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      text: (el.innerText || el.value || '').trim().slice(0, 100),
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      placeholder: el.getAttribute('placeholder') || '',
      aria: el.getAttribute('aria-label') || '',
      href: el.tagName === 'A' ? (el.href || '').slice(0, 500) : '',
      checked: el.checked || false,
      disabled: el.disabled || false,
    };
    var clean = {};
    var keys = Object.keys(entry);
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j], v = entry[k];
      if (v !== '' && v !== false && v !== undefined) clean[k] = v;
    }
    results.push(clean);
  }
  return results;
})()`;

function formatSnapshot(
  elements: any[],
  url: string,
  title: string,
  opts?: { roles?: string[]; offset?: number; limit?: number },
): string {
  if (!elements || !Array.isArray(elements)) elements = [];
  const total = elements.length;
  const roles = (opts?.roles || []).map(r => r.toLowerCase());
  let filtered = elements;
  if (roles.length) {
    filtered = filtered.filter(el =>
      roles.includes((el.tag || "").toLowerCase()) ||
      roles.includes((el.role || "").toLowerCase()) ||
      roles.includes((el.type || "").toLowerCase()));
  }
  const matched = filtered.length;
  const offset = Math.max(0, opts?.offset || 0);
  const limit = opts?.limit && opts.limit > 0 ? opts.limit : 0;
  if (offset) filtered = filtered.slice(offset);
  if (limit) filtered = filtered.slice(0, limit);

  const counts = roles.length
    ? `showing ${filtered.length} of ${matched} matched (${total} total)`
    : (offset || limit) ? `showing ${filtered.length} of ${total}` : `${total}`;
  const lines = [
    `Page: ${title}`,
    `URL: ${url}`,
    "",
    `Interactive elements (${counts}${offset ? `, offset ${offset}` : ""}):`,
    "",
  ];
  for (const el of filtered) {
    const parts = [`[${el.tag || "?"}]`];
    if (el.role) parts.push(`role=${el.role}`);
    if (el.type) parts.push(`type=${el.type}`);
    if (el.text) parts.push(`"${el.text.slice(0, 80)}"`);
    if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
    if (el.aria) parts.push(`aria="${el.aria}"`);
    if (el.href) parts.push(`href="${el.href.slice(0, 60)}"`);
    if (el.checked) parts.push("checked");
    if (el.disabled) parts.push("disabled");
    lines.push(`  ref=${el.ref}  ${parts.join(" ")}`);
  }
  const shownEnd = offset + filtered.length;
  if (matched > shownEnd) {
    lines.push("", `… ${matched - shownEnd} more — call browser_snapshot with offset=${shownEnd}`);
  }
  return lines.join("\n");
}

// Run the DOM snapshot and format it — the evaluate(SNAPSHOT_JS)+formatSnapshot
// pair used by browser_snapshot and every *_and_snapshot compound tool.
async function snapshotPage(
  page: Page,
  opts?: { roles?: string[]; offset?: number; limit?: number },
): Promise<string> {
  const elements = (await page.evaluate(SNAPSHOT_JS)) || [];
  return formatSnapshot(elements as any[], page.url(), await page.title(), opts);
}

// ── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "camoufox-browser",
  version: PKG_VERSION,
});

// Every tool registers through here so workflow_run can invoke tools by name.
// Same signature as server.tool(name, description, schema, handler) — the schema
// is kept so a workflow step gets the same zod validation + defaults a real MCP
// call would get, instead of handlers seeing undefined for omitted params.
const toolRegistry = new Map<string, { schema: any; handler: Function }>();
// Typed as server.tool itself so every handler keeps its inferred argument types.
const regTool: typeof server.tool = ((name: any, description: any, schema: any, handler: any) => {
  toolRegistry.set(name, { schema, handler });
  return (server as any).tool(name, description, schema, handler);
}) as any;

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
    width: z.number().default(0).describe("Window width (0 = default 1280)"),
    height: z.number().default(0).describe("Window height (0 = default 800)"),
    fresh_profile: z.boolean().default(false).describe(
      "Start with a clean temp profile (no carry-over cookies/cache). " +
      "Temp dir is removed when browser_close is called. " +
      "Use when switching between accounts on the same domain to avoid login session collisions."
    ),
  },
  async ({ url, headless, humanize, geoip, locale, width, height, fresh_profile }) => {
    if (browserUp && browserContext) {
      const page = getPage();
      if (url && url !== "about:blank") {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(1500);
      }
      return { content: [{ type: "text", text: `Already running — launch options (headless/humanize/geoip/locale/size/fresh_profile) were IGNORED; call browser_close first to relaunch with new options. Navigated to: ${page.url()}` }] };
    }

    ensureDirs();
    const w = width > 0 ? width : 1280;
    const h = height > 0 ? height : 800;

    // Pick profile dir: fresh temp dir or shared persistent
    let profileDir = PROFILE_DIR;
    let isTemp = false;
    if (fresh_profile) {
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      profileDir = `${PROFILE_PARENT}/profile-fresh-${ts}-${rand}`;
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
        window: [w, h] as [number, number],
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

    browserContext = ctx;
    // Page-error hook must be installed before the first navigation so
    // get_page_errors has something to read (it runs on every page load).
    try { await ctx.addInitScript(ERROR_HOOK_JS); } catch {}
    activeProfileDir = profileDir;
    activeProfileIsTemp = isTemp;
    pages = [];
    activePage = 0;
    browserUp = true;
    // Track pages the site opens itself (window.open / target=_blank), not just
    // tabs we create — otherwise popup/OAuth windows are invisible to all tools.
    ctx.on("page", (p) => trackPage(p));
    const existingPages = ctx.pages();
    const page = existingPages.length > 0 ? existingPages[0] : await ctx.newPage();
    trackPage(page);
    activePage = pages.indexOf(page);
    if (activePage < 0) activePage = 0;

    if (url && url !== "about:blank") {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(1500);
    }
    const title = await page.title();
    const profileNote = isTemp ? " (fresh temp profile)" : "";
    return { content: [{ type: "text", text: `Browser launched${profileNote}. URL: ${page.url()}\nTitle: ${title}` }] };
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
    if (browserContext) {
      try {
        const cookies = await browserContext.cookies();
        const session = cookies.filter((c: any) => !c.expires || c.expires <= 0).length;
        const persisted = cookies.length - session;
        cookieNote = ` Cookies: ${persisted} persisted, ${session} session-only (dropped — standard browser behaviour; use cookie_set(expires_days=…) or storage_state_save to keep a login).`;
      } catch {}
    }
    if (browserContext) {
      try { await browserContext.close(); } catch {}
    }
    let note = "Profile saved." + cookieNote;
    if (activeProfileIsTemp && activeProfileDir) {
      try {
        rmSync(activeProfileDir, { recursive: true, force: true });
        note = `Temp profile removed (${activeProfileDir}).`;
      } catch (e: any) {
        note = `Profile saved. Warning: failed to remove temp profile: ${e?.message || e}`;
      }
    }
    browserContext = null;
    pages = [];
    activePage = 0;
    browserUp = false;
    activeProfileDir = null;
    activeProfileIsTemp = false;
    // Reset capture state so a later launch doesn't read stale cross-session
    // data and the handlers don't pin closed page objects.
    consoleMessages.length = 0;
    networkRequests.length = 0;
    networkSeq = 0;
    networkCaptureBodies = false;
    networkHandler = null;
    consoleHandler = null;
    autoDialogHandler = null;
    autoDialogCfg = null;
    oneShotDialogArmed = false;
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
    if (browserUp) {
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
    await page.goto(url, { waitUntil: wait_until, timeout });
    await page.waitForTimeout(1000);
    return { content: [{ type: "text", text: `Navigated to: ${page.url()}\nTitle: ${await page.title()}` }] };
  }
);

regTool("go_back", "Navigate back in history.", {}, async () => {
  const page = getPage();
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 });
  return { content: [{ type: "text", text: `Went back. URL: ${page.url()}` }] };
});

regTool("go_forward", "Navigate forward in history.", {}, async () => {
  const page = getPage();
  await page.goForward({ waitUntil: "domcontentloaded", timeout: 15000 });
  return { content: [{ type: "text", text: `Went forward. URL: ${page.url()}` }] };
});

regTool("reload", "Reload the current page.", {}, async () => {
  const page = getPage();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
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
    const path = join(SCREENSHOT_DIR, `${name}.png`);
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

// ── Tools: Element Interaction ─────────────────────────────────────────────

regTool(
  "click",
  "Click element by ref ID from browser_snapshot. Auto JS-fallback for overlays.",
  {
    ref: z.string().describe("Element ref (e.g. 'e5')"),
    button: z.enum(["left", "right", "middle"]).default("left"),
    dblclick: z.boolean().default(false),
  },
  async ({ ref, button, dblclick }) => {
    const page = getPage();
    const mode = await clickWithFallback(refLocator(page, ref), { button, dblclick });
    await page.waitForTimeout(1000);
    return { content: [{ type: "text", text: `Clicked ref=${ref}. URL: ${page.url()}${clickNote(mode)}` }] };
  }
);

regTool(
  "click_text",
  "Click element by visible text. If the text matches several elements it FAILS with a numbered candidate list instead of silently clicking the first one — " +
    'narrow with within ("@dialog", a CSS selector, or "ref:e5") or pick one with index.',
  {
    text: z.string().describe("Visible text"),
    exact: z.boolean().default(true),
    within: z.string().default("").describe('Limit the search: "@dialog" = topmost modal, "ref:e5" = inside a snapshot ref, or any CSS selector.'),
    index: z.number().default(-1).describe("Which match to click when several match (0-based). -1 = require a unique match."),
  },
  async ({ text, exact, within, index }) => {
    const page = getPage();
    const scope = within ? ` within=${within}` : "";
    let loc: any;
    try {
      loc = scopeRoot(page, within).getByText(text, { exact });
    } catch (e: any) {
      return { content: [{ type: "text", text: `Invalid within=${within}: ${e?.message || e}` }], isError: true };
    }
    const n = await loc.count();
    if (n === 0) {
      return { content: [{ type: "text", text: `No element matched text='${text}' (exact=${exact})${scope}. Current URL: ${page.url()}. Try exact=false, a different within, browser_snapshot, or click_role.` }], isError: true };
    }
    if (n > 1 && index < 0) {
      const { total, items } = await describeMatches(loc);
      return {
        content: [{ type: "text", text: `Ambiguous: text='${text}'${scope} matches ${total} elements — refusing to guess (clicking the wrong one can be destructive).\n${candidateList(total, items)}\n\nRe-run with index=N, add within="@dialog"/CSS, or click(ref=…) using a ref above.` }],
        isError: true,
      };
    }
    if (index >= n) {
      return { content: [{ type: "text", text: `index=${index} out of range — only ${n} match(es) for text='${text}'${scope}.` }], isError: true };
    }
    const target = index >= 0 ? loc.nth(index) : loc.first();
    const mode = await clickWithFallback(target);
    await page.waitForTimeout(1000);
    return { content: [{ type: "text", text: `Clicked text='${text}'${scope}${n > 1 ? ` [index=${index} of ${n}]` : ""}. URL: ${page.url()}${clickNote(mode)}` }] };
  }
);

regTool(
  "click_role",
  "Click element by ARIA role and name. Same ambiguity guard as click_text: several matches → candidate list, not a guess.",
  {
    role: z.string().describe("ARIA role (button, link, textbox, etc.)"),
    name: z.string().default("").describe("Accessible name"),
    within: z.string().default("").describe('Limit the search: "@dialog", "ref:e5", or a CSS selector.'),
    index: z.number().default(-1).describe("Which match to click when several match (0-based). -1 = require a unique match."),
  },
  async ({ role, name: ariaName, within, index }) => {
    const page = getPage();
    const scope = within ? ` within=${within}` : "";
    let loc: any;
    try {
      const root = scopeRoot(page, within);
      loc = ariaName ? root.getByRole(role as any, { name: ariaName, exact: true }) : root.getByRole(role as any);
    } catch (e: any) {
      return { content: [{ type: "text", text: `Invalid within=${within}: ${e?.message || e}` }], isError: true };
    }
    const n = await loc.count();
    if (n === 0) {
      return { content: [{ type: "text", text: `No element matched role=${role} name='${ariaName}'${scope}. Current URL: ${page.url()}. Try browser_snapshot or click_text.` }], isError: true };
    }
    if (n > 1 && index < 0) {
      const { total, items } = await describeMatches(loc);
      return {
        content: [{ type: "text", text: `Ambiguous: role=${role} name='${ariaName}'${scope} matches ${total} elements — refusing to guess.\n${candidateList(total, items)}\n\nRe-run with index=N, add within=…, or click(ref=…).` }],
        isError: true,
      };
    }
    if (index >= n) {
      return { content: [{ type: "text", text: `index=${index} out of range — only ${n} match(es) for role=${role} name='${ariaName}'${scope}.` }], isError: true };
    }
    const target = index >= 0 ? loc.nth(index) : loc.first();
    const mode = await clickWithFallback(target);
    await page.waitForTimeout(1000);
    return { content: [{ type: "text", text: `Clicked role=${role} name='${ariaName}'${scope}${n > 1 ? ` [index=${index} of ${n}]` : ""}. URL: ${page.url()}${clickNote(mode)}` }] };
  }
);

regTool("hover", "Hover over element by ref ID.", {
  ref: z.string(),
}, async ({ ref }) => {
  const page = getPage();
  await refLocator(page, ref).hover({ timeout: ACTION_TIMEOUT });
  return { content: [{ type: "text", text: `Hovered ref=${ref}` }] };
});

regTool("fill", "Fill input/textarea by ref ID. Always replaces existing content (email/number inputs are cleared explicitly first — Firefox's select-all is a no-op on those, which would otherwise append).", {
  ref: z.string().describe("Element ref"),
  value: z.string().describe("Text to fill"),
}, async ({ ref, value }) => {
  const page = getPage();
  await fillLocator(refLocator(page, ref), value);
  return { content: [{ type: "text", text: `Filled ref=${ref} with '${value.slice(0, 50)}'` }] };
});

regTool("select_option", "Select option from <select> dropdown.", {
  ref: z.string(), value: z.string(),
}, async ({ ref, value }) => {
  const page = getPage();
  await refLocator(page, ref).selectOption(value, { timeout: ACTION_TIMEOUT });
  return { content: [{ type: "text", text: `Selected '${value}' in ref=${ref}` }] };
});

regTool("check", "Check checkbox or radio button.", { ref: z.string() }, async ({ ref }) => {
  const page = getPage();
  await refLocator(page, ref).check({ timeout: ACTION_TIMEOUT });
  return { content: [{ type: "text", text: `Checked ref=${ref}` }] };
});

regTool("uncheck", "Uncheck a checkbox.", { ref: z.string() }, async ({ ref }) => {
  const page = getPage();
  await refLocator(page, ref).uncheck({ timeout: ACTION_TIMEOUT });
  return { content: [{ type: "text", text: `Unchecked ref=${ref}` }] };
});

// ── Tools: Keyboard ────────────────────────────────────────────────────────

regTool("type_text", "Type text char by char via keyboard.", {
  text: z.string(),
  delay: z.number().default(50).describe("Delay between keys (ms)"),
}, async ({ text, delay }) => {
  const page = getPage();
  await page.keyboard.type(text, { delay });
  return { content: [{ type: "text", text: `Typed: '${text.slice(0, 50)}'` }] };
});

regTool("press_key", "Press key or combo (Enter, Escape, Control+a, etc.).", {
  key: z.string().describe("Key name"),
}, async ({ key }) => {
  const page = getPage();
  await page.keyboard.press(key);
  await page.waitForTimeout(300);
  return { content: [{ type: "text", text: `Pressed: ${key}` }] };
});

// ── Tools: Wait ────────────────────────────────────────────────────────────

regTool("wait_for", "Wait for element/text to appear or disappear.", {
  selector: z.string().default("").describe("CSS selector"),
  text: z.string().default("").describe("Text to wait for"),
  state: z.enum(["visible", "hidden", "attached", "detached"]).default("visible"),
  timeout: z.number().default(10000),
}, async ({ selector, text, state, timeout }) => {
  const page = getPage();
  if (selector) {
    await page.locator(selector).first().waitFor({ state, timeout });
    return { content: [{ type: "text", text: `Selector '${selector}' is now ${state}` }] };
  } else if (text) {
    await page.getByText(text).first().waitFor({ state, timeout });
    return { content: [{ type: "text", text: `Text '${text}' is now ${state}` }] };
  }
  await page.waitForTimeout(timeout);
  return { content: [{ type: "text", text: `Waited ${timeout}ms` }] };
});

regTool("wait_for_navigation", "Wait for page load to complete.", {
  timeout: z.number().default(15000),
}, async ({ timeout }) => {
  const page = getPage();
  await page.waitForLoadState("domcontentloaded", { timeout });
  return { content: [{ type: "text", text: `Navigation complete. URL: ${page.url()}` }] };
});

regTool(
  "wait_for_any_of",
  "Race multiple wait conditions — returns the first that matches, so the agent can branch immediately without sequential probes. " +
    "Each condition is {kind: 'selector'|'text'|'url_contains'|'title_contains', value: string}. " +
    "Returns the index + kind + value of the winning condition (or 'timeout' if none matched). " +
    "Ideal for post-login flows where the next page could be any of several (e.g. 'Stay signed in?', 'Skip for now', or the inbox directly).",
  {
    conditions: z.array(z.object({
      kind: z.enum(["selector", "text", "url_contains", "title_contains"]),
      value: z.string(),
    })).describe("Conditions to race. First match wins."),
    timeout: z.number().default(15000).describe("Max wait in ms"),
  },
  async ({ conditions, timeout }) => {
    if (!conditions || conditions.length === 0) {
      return {
        content: [{ type: "text", text: "Error: conditions array is empty" }],
        isError: true,
      };
    }
    const page = getPage();
    const deadline = Date.now() + timeout;

    // Poll-based race — works for url/title (no native waitFor for those across all kinds)
    // and for selector/text uses Playwright's waitFor with short slices so we can return early
    // when a different condition wins.
    const pollMs = 250;
    while (Date.now() < deadline) {
      // Check all conditions in parallel via a single page.evaluate where possible
      const url = page.url();
      const title = await page.title().catch(() => "");
      for (let i = 0; i < conditions.length; i++) {
        const c = conditions[i];
        try {
          if (c.kind === "url_contains" && url.includes(c.value)) {
            return { content: [{ type: "text", text: `matched index=${i} kind=url_contains value="${c.value}" url=${url}` }] };
          }
          if (c.kind === "title_contains" && title.toLowerCase().includes(c.value.toLowerCase())) {
            return { content: [{ type: "text", text: `matched index=${i} kind=title_contains value="${c.value}" title="${title}"` }] };
          }
          if (c.kind === "selector") {
            const visible = await page.locator(c.value).first().isVisible().catch(() => false);
            if (visible) {
              return { content: [{ type: "text", text: `matched index=${i} kind=selector value="${c.value}"` }] };
            }
          }
          if (c.kind === "text") {
            const visible = await page.getByText(c.value).first().isVisible().catch(() => false);
            if (visible) {
              return { content: [{ type: "text", text: `matched index=${i} kind=text value="${c.value}"` }] };
            }
          }
        } catch {}
      }
      await page.waitForTimeout(pollMs);
    }
    return {
      content: [{ type: "text", text: `timeout: no condition matched within ${timeout}ms. Current URL: ${page.url()}` }],
    };
  }
);

// ── Tools: JavaScript ──────────────────────────────────────────────────────

regTool("evaluate", "Execute JavaScript in page context.", {
  expression: z.string().describe("JS expression"),
}, async ({ expression }) => {
  const page = getPage();
  const result = await page.evaluate(expression);
  const text = typeof result === "object" ? JSON.stringify(result, null, 2) : String(result);
  return { content: [{ type: "text", text }] };
});

// ── Tools: Page Info ───────────────────────────────────────────────────────

regTool("get_url", "Get current URL and title.", {}, async () => {
  const page = getPage();
  return { content: [{ type: "text", text: `URL: ${page.url()}\nTitle: ${await page.title()}` }] };
});

regTool("get_text", "Get visible text from page or element.", {
  selector: z.string().default("body"),
}, async ({ selector }) => {
  const page = getPage();
  let text = await page.locator(selector).first().innerText({ timeout: ACTION_TIMEOUT });
  if (text.length > 5000) text = text.slice(0, 5000) + `\n... (truncated, ${text.length} chars)`;
  return { content: [{ type: "text", text }] };
});

regTool("get_html", "Get HTML content from page or element.", {
  selector: z.string().default("body"),
  outer: z.boolean().default(false),
}, async ({ selector, outer }) => {
  const page = getPage();
  const loc = page.locator(selector).first();
  let html = outer
    ? await loc.evaluate((el: any) => el.outerHTML)
    : await loc.innerHTML({ timeout: ACTION_TIMEOUT });
  if (html.length > 10000) html = html.slice(0, 10000) + `\n<!-- truncated -->`;
  return { content: [{ type: "text", text: html }] };
});

// ── Tools: Tab Management ──────────────────────────────────────────────────

regTool("tab_list", "List all open tabs.", {}, async () => {
  const lines: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const a = i === activePage ? " (active)" : "";
    let title = "(closed)";
    try { title = await pages[i].title(); } catch {}
    lines.push(`  [${i}]${a} ${pages[i].url()} — ${title}`);
  }
  return { content: [{ type: "text", text: `Tabs (${pages.length}):\n${lines.join("\n")}` }] };
});

regTool("tab_new", "Open new tab.", {
  url: z.string().default("about:blank"),
}, async ({ url }) => {
  if (!browserContext) throw new Error("Browser not running. Call browser_launch first.");
  const page = await browserContext.newPage();
  if (url && url !== "about:blank") {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  }
  // newPage() also fires the context "page" event → trackPage may already have
  // added it; trackPage is idempotent, so this just guarantees it's present.
  trackPage(page);
  activePage = pages.indexOf(page);
  return { content: [{ type: "text", text: `New tab [${activePage}]. URL: ${page.url()}` }] };
});

regTool("tab_select", "Switch to a tab by index, or by url_contains (first tab whose URL contains the substring).", {
  index: z.number().default(-1).describe("Tab index. Ignored if url_contains is set."),
  url_contains: z.string().default("").describe("Select the first tab whose URL contains this substring."),
}, async ({ index, url_contains }) => {
  if (!pages.length) return { content: [{ type: "text", text: "No tabs open." }] };
  let idx = index;
  if (url_contains) {
    idx = pages.findIndex(p => { try { return p.url().includes(url_contains); } catch { return false; } });
    if (idx < 0) {
      const list = pages.map((p, i) => { let u = "?"; try { u = p.url(); } catch {} return `[${i}] ${u}`; }).join("\n  ");
      return { content: [{ type: "text", text: `No tab URL contains "${url_contains}". Open tabs:\n  ${list}` }] };
    }
  }
  if (idx < 0 || idx >= pages.length) {
    return { content: [{ type: "text", text: `Invalid index ${idx}. Have ${pages.length} tabs. Pass index or url_contains.` }] };
  }
  activePage = idx;
  try { await pages[idx].bringToFront(); } catch {}
  return { content: [{ type: "text", text: `Switched to tab [${idx}]. URL: ${pages[idx].url()}` }] };
});

regTool("tab_close", "Close a tab by index (-1 = active), or by url_contains.", {
  index: z.number().default(-1),
  url_contains: z.string().default("").describe("Close the first tab whose URL contains this substring (overrides index)."),
}, async ({ index, url_contains }) => {
  let idx: number;
  if (url_contains) {
    idx = pages.findIndex(p => { try { return p.url().includes(url_contains); } catch { return false; } });
    if (idx < 0) return { content: [{ type: "text", text: `No tab URL contains "${url_contains}".` }] };
  } else {
    idx = index === -1 ? activePage : index;
  }
  if (idx < 0 || idx >= pages.length) {
    return { content: [{ type: "text", text: `Invalid index.` }] };
  }
  // Remember the active page by IDENTITY before splicing — closing a
  // lower-indexed tab shifts every later index down, so a plain
  // Math.min(activePage, len-1) would silently move "active" to another tab.
  const activeObj = pages[activePage];
  const page = pages.splice(idx, 1)[0];
  try { await page.close(); } catch {}
  if (pages.length === 0) {
    activePage = 0;
    return { content: [{ type: "text", text: "Last tab closed." }] };
  }
  const reFound = pages.indexOf(activeObj);
  // If we closed the active tab itself, fall back to whatever took its slot.
  activePage = reFound >= 0 ? reFound : Math.min(idx, pages.length - 1);
  return { content: [{ type: "text", text: `Closed tab [${idx}]. Active: [${activePage}] ${pages[activePage].url()}` }] };
});

// ── Tools: Cookies ─────────────────────────────────────────────────────────

regTool("cookie_list", "List cookies.", {
  domain: z.string().default(""),
}, async ({ domain }) => {
  if (!browserContext) throw new Error("Browser not running. Call browser_launch first.");
  let cookies = await browserContext.cookies();
  if (domain) cookies = cookies.filter(c => c.domain.includes(domain));
  const lines = cookies.slice(0, 50).map(c => `  ${c.name}=${String(c.value).slice(0, 40)}  domain=${c.domain}`);
  return { content: [{ type: "text", text: lines.length ? `Cookies (${cookies.length}):\n${lines.join("\n")}` : "No cookies." }] };
});

regTool("cookie_set",
  "Set a cookie. IMPORTANT: with expires_days=0 this creates a SESSION cookie, which Firefox keeps in memory only — " +
  "it is gone after browser_close even though the profile itself persists. Pass expires_days (e.g. 30) to write a " +
  "login session that survives a relaunch.",
  {
    name: z.string(), value: z.string(), domain: z.string(), path: z.string().default("/"),
    expires_days: z.number().default(0).describe("Lifetime in days. 0 = session cookie (dies with the browser)."),
    http_only: z.boolean().default(false).describe("Set the HttpOnly flag (hides it from page JS, like a real auth cookie)."),
    secure: z.boolean().default(false).describe("Set the Secure flag (HTTPS only). Required when same_site='None'."),
    same_site: z.enum(["Lax", "Strict", "None"]).default("Lax"),
  },
  async ({ name, value, domain, path, expires_days, http_only, secure, same_site }) => {
    if (!browserContext) throw new Error("Browser not running. Call browser_launch first.");
    const cookie: any = { name, value, domain, path, httpOnly: http_only, secure, sameSite: same_site };
    // Playwright: expires is epoch SECONDS; -1 (or omitted) means session cookie.
    if (expires_days > 0) cookie.expires = Math.floor(Date.now() / 1000 + expires_days * 86400);
    if (same_site === "None" && !secure) {
      return { content: [{ type: "text", text: "same_site='None' requires secure=true — browsers reject SameSite=None without Secure." }], isError: true };
    }
    await browserContext.addCookies([cookie]);
    const life = expires_days > 0
      ? `expires in ${expires_days}d (survives browser_close)`
      : "SESSION cookie — will be LOST on browser_close; pass expires_days to persist";
    return { content: [{ type: "text", text: `Cookie set: ${name}=${value.slice(0, 40)} domain=${domain} — ${life}` }] };
  });

regTool("cookie_delete", "Delete cookies. Both empty = clear all.", {
  name: z.string().default(""), domain: z.string().default(""),
}, async ({ name, domain }) => {
  if (!browserContext) throw new Error("Browser not running. Call browser_launch first.");
  if (!name && !domain) {
    await browserContext.clearCookies();
    return { content: [{ type: "text", text: "All cookies cleared." }] };
  }
  const cookies = await browserContext.cookies();
  const toKeep = cookies.filter(c => {
    const matchN = !name || c.name === name;
    const matchD = !domain || c.domain.includes(domain);
    return !(matchN && matchD);
  });
  const deleted = cookies.length - toKeep.length;
  await browserContext.clearCookies();
  if (toKeep.length) await browserContext.addCookies(toKeep as any);
  return { content: [{ type: "text", text: `Deleted ${deleted} cookie(s).` }] };
});

// ── Tools: Dialog ──────────────────────────────────────────────────────────

regTool("dialog_handle", "Set handler for the next alert/confirm/prompt on ANY open tab (first dialog wins, handler then clears).", {
  action: z.enum(["accept", "dismiss"]).default("accept"),
  prompt_text: z.string().default(""),
}, async ({ action, prompt_text }) => {
  if (!pages.length) throw new Error("Browser not running. Call browser_launch first.");
  // Arm every tab, not just the active one — a dialog can fire on a popup the
  // site opened. The first dialog disarms all tabs; later dialogs get
  // Playwright's default auto-dismiss instead of hanging the page.
  const armed = pages.slice();
  let used = false;
  // Tell a persistent dialog_auto_handle to stand down for this one dialog.
  oneShotDialogArmed = true;
  const handler = async (dialog: Dialog) => {
    if (used) { try { await dialog.dismiss(); } catch {} return; }
    used = true;
    oneShotDialogArmed = false;
    for (const p of armed) { try { p.off("dialog", handler); } catch {} }
    try {
      if (action === "accept") await dialog.accept(prompt_text);
      else await dialog.dismiss();
    } catch {}
  };
  for (const p of armed) p.on("dialog", handler);
  return { content: [{ type: "text", text: `Next dialog will be ${action}'d (armed on ${armed.length} tab(s))` }] };
});

// ── Tools: File Upload ─────────────────────────────────────────────────────

regTool("upload_file", "Upload file to file input.", {
  ref: z.string(), file_path: z.string(),
}, async ({ ref, file_path }) => {
  const page = getPage();
  await refLocator(page, ref).setInputFiles(file_path, { timeout: ACTION_TIMEOUT });
  return { content: [{ type: "text", text: `Uploaded ${file_path} to ref=${ref}` }] };
});

// ── Tool: ChatGPT image generation (high-level, end-to-end) ──────────────────
regTool(
  "chatgpt_generate_image",
  "Generate or edit an image on chatgpt.com end-to-end and save it to disk in ONE call. Opens a fresh chat, optionally uploads reference images (e.g. a brand logo), submits the prompt, waits for the generated image to finish, then writes the result PNG to output_path. Requires an authenticated chatgpt.com session (import cookies first via cookie_import). Returns the saved path and pixel dimensions. Note: chatgpt image generation is slow (~60-120s) — set timeout_ms accordingly.",
  {
    prompt: z.string().describe("Text prompt for image generation/editing."),
    output_path: z.string().describe("Absolute path to write the resulting PNG."),
    image_paths: z.array(z.string()).default([]).describe("Optional reference image file paths to upload before prompting (e.g. a logo)."),
    timeout_ms: z.number().default(240000).describe("Max ms to wait for the generated image."),
  },
  async ({ prompt, output_path, image_paths, timeout_ms }) => {
    const page = getPage();
    // 1) fresh chat
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("#prompt-textarea", { timeout: 30000 });
    // dismiss blocking modals (e.g. subscription-failure) that intercept clicks
    try { await page.evaluate(`(() => { const m = document.getElementById('modal-subscription-failure'); if (m) m.remove(); document.querySelectorAll('div[data-state="open"].z-50').forEach(e => e.remove()); })()`); } catch {}
    try { await page.keyboard.press("Escape"); } catch {}
    // 2) upload reference images (e.g. logo) to the hidden file input
    if (image_paths.length > 0) {
      await page.locator('input[type="file"]').first().setInputFiles(image_paths, { timeout: ACTION_TIMEOUT });
      await page.waitForTimeout(2500); // let thumbnails attach
    }
    // 3) type prompt + submit
    const editor = page.locator("#prompt-textarea");
    await editor.click();
    await page.keyboard.insertText(prompt);
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
    // 4) wait for a finished assistant image (>=1000px, loaded)
    const READY = `(() => { const imgs = Array.from(document.querySelectorAll('main img')).filter(i => !i.closest('[data-message-author-role="user"]')); return imgs.some(i => i.complete && i.naturalWidth >= 1000 && i.naturalHeight >= 1000); })()`;
    await page.waitForFunction(READY, undefined, { timeout: timeout_ms, polling: 2000 });
    // 5) settle until the largest image src stops changing (preview -> final)
    let lastSrc = "";
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(2500);
      const cur = await page.evaluate(`(() => { const imgs = Array.from(document.querySelectorAll('main img')).filter(i => !i.closest('[data-message-author-role="user"]')).filter(i => i.complete && i.naturalWidth >= 1000); imgs.sort((a,b)=>(b.naturalWidth*b.naturalHeight)-(a.naturalWidth*a.naturalHeight)); return imgs[0] ? imgs[0].src : ""; })()`) as string;
      if (cur && cur === lastSrc) break;
      lastSrc = cur;
    }
    // 6) fetch the largest assistant image as a data URL, write to disk
    const dataUrl = await page.evaluate(`(async () => { const imgs = Array.from(document.querySelectorAll('main img')).filter(i => !i.closest('[data-message-author-role="user"]')).filter(i => i.complete && i.naturalWidth >= 1000); imgs.sort((a,b)=>(b.naturalWidth*b.naturalHeight)-(a.naturalWidth*a.naturalHeight)); const big = imgs[0]; if (!big) return null; const r = await fetch(big.src); const b = await r.blob(); return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }); })()`) as string | null;
    if (!dataUrl || typeof dataUrl !== "string" || dataUrl.indexOf(",") < 0) {
      throw new Error("Generated image not found / could not be fetched after wait.");
    }
    const dims = await page.evaluate(`(() => { const imgs = Array.from(document.querySelectorAll('main img')).filter(i => !i.closest('[data-message-author-role="user"]')).filter(i => i.complete && i.naturalWidth >= 1000); imgs.sort((a,b)=>(b.naturalWidth*b.naturalHeight)-(a.naturalWidth*a.naturalHeight)); const big = imgs[0]; return big ? (big.naturalWidth + "x" + big.naturalHeight) : "?"; })()`) as string;
    const buf = Buffer.from(dataUrl.split(",")[1], "base64");
    const target = resolveOutPath(output_path);
    writeFileSync(target, buf);
    return { content: [{ type: "text", text: `Saved ${target} (${dims}, ${buf.length} bytes)` }] };
  }
);

regTool(
  "chatgpt_generate_batch",
  "Generate MANY images on chatgpt.com IN PARALLEL (one tab per job, fire-all-then-collect) and save each to disk. Submits every job first WITHOUT waiting, then waits for all generations concurrently — far faster than sequential. For a CONSISTENT feed set, pass shared_image_paths (e.g. [logo] and/or a style-reference image like a previously-generated hero) uploaded to EVERY tab, plus style_suffix (a shared style spec) appended to every prompt. Requires an authenticated chatgpt.com session (import cookies first). Returns per-job results (saved path / ok / bytes / error).",
  {
    jobs: z.array(z.object({ prompt: z.string(), output_path: z.string() })).describe("Per-image jobs: each has a prompt and an output PNG path."),
    shared_image_paths: z.array(z.string()).default([]).describe("Reference images uploaded to EVERY tab (e.g. [logoPath, styleRefPath]) — key for visual consistency."),
    style_suffix: z.string().default("").describe("Shared style spec text appended to every prompt (exact colors, typography, layout, mood) for consistency."),
    timeout_ms: z.number().default(300000).describe("Max ms to wait for each image to finish."),
    stagger_ms: z.number().default(900).describe("Delay between submitting each tab (avoids UI/anti-bot races)."),
  },
  async ({ jobs, shared_image_paths, style_suffix, timeout_ms, stagger_ms }) => {
    if (!browserContext) throw new Error("Browser not running. Call browser_launch first.");
    const NOTUSER = `Array.from(document.querySelectorAll('main img')).filter(i => !i.closest('[data-message-author-role="user"]'))`;
    const submit = async (page: Page, prompt: string) => {
      await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector("#prompt-textarea", { timeout: 30000 });
      try { await page.evaluate(`(() => { const m=document.getElementById('modal-subscription-failure'); if(m)m.remove(); document.querySelectorAll('div[data-state="open"].z-50').forEach(e=>e.remove()); })()`); } catch {}
      if (shared_image_paths.length > 0) {
        await page.locator('input[type="file"]').first().setInputFiles(shared_image_paths, { timeout: ACTION_TIMEOUT });
        await page.waitForTimeout(2500);
      }
      await page.locator("#prompt-textarea").click();
      await page.keyboard.insertText(prompt + (style_suffix ? "\n\n" + style_suffix : ""));
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");
    };
    const collect = async (page: Page, output_path: string): Promise<number> => {
      const READY = `(() => { const imgs = ${NOTUSER}; return imgs.some(i => i.complete && i.naturalWidth >= 1000 && i.naturalHeight >= 1000); })()`;
      await page.waitForFunction(READY, undefined, { timeout: timeout_ms, polling: 2000 });
      let last = "";
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(2500);
        const cur = await page.evaluate(`(() => { const imgs = ${NOTUSER}.filter(i => i.complete && i.naturalWidth >= 1000); imgs.sort((a,b)=>(b.naturalWidth*b.naturalHeight)-(a.naturalWidth*a.naturalHeight)); return imgs[0] ? imgs[0].src : ""; })()`) as string;
        if (cur && cur === last) break;
        last = cur;
      }
      const dataUrl = await page.evaluate(`(async () => { const imgs = ${NOTUSER}.filter(i => i.complete && i.naturalWidth >= 1000); imgs.sort((a,b)=>(b.naturalWidth*b.naturalHeight)-(a.naturalWidth*a.naturalHeight)); const big = imgs[0]; if (!big) return null; const r = await fetch(big.src); const b = await r.blob(); return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }); })()`) as string | null;
      if (!dataUrl || typeof dataUrl !== "string" || dataUrl.indexOf(",") < 0) throw new Error("image not found");
      const buf = Buffer.from(dataUrl.split(",")[1], "base64");
      writeFileSync(resolveOutPath(output_path), buf);
      return buf.length;
    };
    // Phase 1: open a tab per job and SUBMIT (staggered), without waiting for generation
    const entries: { page: Page; output_path: string; submitErr: string | null }[] = [];
    for (const job of jobs) {
      const page = await browserContext.newPage();
      let submitErr: string | null = null;
      try { await submit(page, job.prompt); } catch (e) { submitErr = String(e); }
      entries.push({ page, output_path: job.output_path, submitErr });
      await page.waitForTimeout(stagger_ms);
    }
    // Phase 2: wait for ALL generations concurrently + save
    const results = await Promise.all(entries.map(async (en) => {
      if (en.submitErr) return { output_path: en.output_path, ok: false, error: "submit: " + en.submitErr };
      try { const bytes = await collect(en.page, en.output_path); return { output_path: en.output_path, ok: true, bytes }; }
      catch (e) { return { output_path: en.output_path, ok: false, error: String(e) }; }
    }));
    for (const en of entries) { try { await en.page.close(); } catch {} }
    const okCount = results.filter(r => r.ok).length;
    return { content: [{ type: "text", text: `Batch done: ${okCount}/${jobs.length} succeeded.\n` + JSON.stringify(results, null, 2) }] };
  }
);

// ── Tools: Scroll ──────────────────────────────────────────────────────────

regTool("scroll", "Scroll the page.", {
  direction: z.enum(["up", "down", "left", "right"]).default("down"),
  amount: z.number().default(500),
}, async ({ direction, amount }) => {
  const page = getPage();
  let dx = 0, dy = 0;
  if (direction === "down") dy = amount;
  else if (direction === "up") dy = -amount;
  else if (direction === "right") dx = amount;
  else if (direction === "left") dx = -amount;
  // Use JS scroll — mouse.wheel doesn't work reliably in Firefox/Camoufox
  await page.evaluate(`window.scrollBy(${dx}, ${dy})`);
  await page.waitForTimeout(300);
  return { content: [{ type: "text", text: `Scrolled ${direction} ${amount}px` }] };
});

// ── Tools: Console & Network ───────────────────────────────────────────────

const consoleMessages: { type: string; text: string }[] = [];

interface NetEntry {
  id: number;
  ts: number;                        // capture time (ms epoch) — used by export_har
  method: string;
  status: number;
  url: string;                       // full URL (truncated only in list view)
  resourceType: string;
  reqHeaders?: Record<string, string>;
  reqBody?: string;
  resHeaders?: Record<string, string>;
  resBody?: string;
  resBodyTruncated?: boolean;
  mimeType?: string;
}
const networkRequests: NetEntry[] = [];
let networkCaptureBodies = false;
let networkSeq = 0;
let networkHandler: ((res: any) => void) | null = null;
let consoleHandler: ((msg: any) => void) | null = null;

regTool("console_start", "Start capturing console messages from all tabs.", {}, async () => {
  if (!browserContext) throw new Error("Browser not running. Call browser_launch first.");
  consoleMessages.length = 0;
  // Detach any prior handler from every page first so repeated console_start
  // calls don't stack listeners (and don't capture each message N times).
  if (consoleHandler) for (const p of pages) { try { p.off("console", consoleHandler); } catch {} }
  consoleHandler = (msg: any) => {
    consoleMessages.push({ type: msg.type(), text: msg.text().slice(0, 200) });
  };
  // Attach to every current page; trackPage() attaches it to future tabs/popups,
  // so capture follows the user across tab switches instead of dying on tab 0.
  for (const p of pages) p.on("console", consoleHandler);
  return { content: [{ type: "text", text: `Console capture started (all ${pages.length} tab(s)).` }] };
});

regTool("console_get", "Get captured console messages.", {}, async () => {
  if (!consoleMessages.length) return { content: [{ type: "text", text: "No messages." }] };
  const lines = consoleMessages.slice(-50).map(m => `  [${m.type}] ${m.text}`);
  return { content: [{ type: "text", text: `Console (${consoleMessages.length}):\n${lines.join("\n")}` }] };
});

regTool("network_start",
  "Start capturing network requests. With capture_bodies=true also records request/response " +
  "headers + text bodies (json/text/xml/form only, capped at body_limit bytes) so you can inspect " +
  "API payloads via network_get_detail — no need to pivot to evaluate()+fetch().",
  {
    capture_bodies: z.boolean().default(false).describe("Also capture request/response headers and text bodies."),
    body_limit: z.number().default(50000).describe("Max bytes kept per request/response body."),
  },
  async ({ capture_bodies, body_limit }) => {
    if (!browserContext) throw new Error("Browser not running. Call browser_launch first.");
    networkRequests.length = 0;
    networkSeq = 0;
    networkCaptureBodies = capture_bodies;
    // Detach a prior handler from every page so repeated network_start calls
    // don't stack listeners or orphan the handler on a since-switched tab.
    if (networkHandler) for (const p of pages) { try { p.off("response", networkHandler); } catch {} }
    networkHandler = (res: any) => {
      // Fire-and-forget: body reads are async and must not block the event loop.
      (async () => {
        try {
          const req = res.request();
          const entry: NetEntry = {
            id: networkSeq++,
            ts: Date.now(),
            method: req.method(),
            status: res.status(),
            url: res.url(),
            resourceType: typeof req.resourceType === "function" ? req.resourceType() : "",
          };
          if (networkCaptureBodies) {
            try { entry.reqHeaders = await req.allHeaders(); } catch {}
            try { const pd = req.postData(); if (pd) entry.reqBody = pd.slice(0, body_limit); } catch {}
            try { entry.resHeaders = await res.allHeaders(); } catch {}
            const ct = (entry.resHeaders?.["content-type"] || "").toLowerCase();
            entry.mimeType = ct;
            // Only decode text-ish payloads — skip images/fonts/binary blobs.
            if (ct === "" || /json|text|javascript|xml|html|urlencoded|graphql/.test(ct)) {
              try {
                const buf = await res.body();
                if (buf) {
                  const txt = buf.toString("utf8");
                  entry.resBody = txt.slice(0, body_limit);
                  if (txt.length > body_limit) entry.resBodyTruncated = true;
                }
              } catch {}
            }
          }
          networkRequests.push(entry);
          if (networkRequests.length > 500) networkRequests.shift();
        } catch {}
      })();
    };
    // Attach to every current page; trackPage() handles future tabs/popups.
    for (const p of pages) p.on("response", networkHandler);
    return { content: [{ type: "text", text: `Network capture started${capture_bodies ? ` (bodies ON, limit ${body_limit}B)` : ""} on ${pages.length} tab(s).` }] };
  });

regTool("network_get",
  "List captured network requests in capture order, keeping the most recent `limit` rows. Each row shows an #id usable with network_get_detail.",
  {
    filter: z.string().default("").describe("Only show requests whose URL contains this substring."),
    limit: z.number().default(50).describe("Max rows to return."),
  },
  async ({ filter, limit }) => {
    let rows = networkRequests;
    if (filter) rows = rows.filter(r => r.url.includes(filter));
    if (!rows.length) return { content: [{ type: "text", text: filter ? `No requests match "${filter}".` : "No requests." }] };
    const slice = rows.slice(-limit);
    const lines = slice.map(r => `  #${r.id} ${r.method} ${r.status} ${r.url.slice(0, 120)}`);
    const hint = networkCaptureBodies
      ? "\n(bodies captured — network_get_detail(id) for full request/response)"
      : "\n(headers/bodies NOT captured — restart with network_start capture_bodies=true)";
    return { content: [{ type: "text", text: `Network (${rows.length}${filter ? " matched" : ""}):\n${lines.join("\n")}${hint}` }] };
  });

regTool("network_get_detail",
  "Full request + response detail (headers and text body) for one captured request. " +
  "Requires network_start(capture_bodies=true) BEFORE the request fired. " +
  "Identify the request by id (from network_get) or by url substring.",
  {
    id: z.number().default(-1).describe("Request #id from network_get. -1 = match by url instead."),
    url: z.string().default("").describe("When id=-1, match the newest request whose URL contains this substring."),
  },
  async ({ id, url }) => {
    let entry: NetEntry | undefined;
    if (id >= 0) entry = networkRequests.find(r => r.id === id);
    else if (url) { const m = networkRequests.filter(r => r.url.includes(url)); entry = m[m.length - 1]; }
    if (!entry) return { content: [{ type: "text", text: "No matching request. Run network_get to list ids." }] };
    if (!networkCaptureBodies && !entry.reqHeaders && !entry.resBody) {
      return { content: [{ type: "text", text: `Request #${entry.id} found, but bodies weren't captured. Run network_start(capture_bodies=true), replay the action, then retry.` }] };
    }
    const fmtH = (h?: Record<string, string>) => h ? Object.entries(h).map(([k, v]) => `    ${k}: ${v}`).join("\n") : "    (none)";
    const out = [
      `#${entry.id} ${entry.method} ${entry.status}  ${entry.url}`,
      `resourceType: ${entry.resourceType || "?"}  mime: ${entry.mimeType || "?"}`,
      "", "── Request headers ──", fmtH(entry.reqHeaders),
      ...(entry.reqBody ? ["", "── Request body ──", entry.reqBody] : []),
      "", "── Response headers ──", fmtH(entry.resHeaders),
      "", "── Response body ──",
      entry.resBody ? (entry.resBody + (entry.resBodyTruncated ? "\n…(truncated)" : "")) : "(empty / binary / not captured)",
    ];
    return { content: [{ type: "text", text: out.join("\n") }] };
  });

// ── Tools: PDF ─────────────────────────────────────────────────────────────

regTool("save_pdf",
  "Save page as PDF. NOTE: Playwright can only generate PDFs in headless Chromium — Camoufox is Firefox, " +
  "so this fails by design here. Use screenshot(full_page=true) instead. Kept for API compatibility.",
  {
    path: z.string().default(""),
  }, async ({ path: pdfPath }) => {
  const page = getPage();
  const target = pdfPath ? resolveOutPath(pdfPath) : join(SCREENSHOT_DIR, "page.pdf");
  try {
    await page.pdf({ path: target });
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/Headless Chromium|not implemented|not supported/i.test(msg)) {
      return {
        content: [{ type: "text", text: "save_pdf is unavailable on Camoufox: Playwright implements PDF generation only for headless Chromium, and Camoufox is a Firefox build. Use screenshot(full_page=true) for a full-page capture instead." }],
        isError: true,
      };
    }
    throw e;
  }
  return { content: [{ type: "text", text: `PDF saved: ${target}` }] };
});

// ── Tools: Batch Operations ────────────────────────────────────────────────

regTool("batch_actions", "Execute multiple actions in one call. Each action: {type, ref?, value?, text?, key?, url?}.", {
  actions: z.array(z.object({
    type: z.enum(["click", "fill", "type", "press", "select", "check", "uncheck", "wait"]),
    ref: z.string().optional(),
    value: z.string().optional(),
    text: z.string().optional(),
    key: z.string().optional(),
    timeout: z.number().optional(),
  })).describe("List of actions to execute sequentially"),
}, async ({ actions }) => {
  const page = getPage();
  const results: string[] = [];
  for (const action of actions) {
    try {
      if (action.type === "click" && action.ref) {
        const mode = await clickWithFallback(refLocator(page, action.ref));
        results.push(`click ${action.ref}: OK${mode === "fallback" ? " (⚠ synthetic fallback — verify effect)" : ""}`);
      } else if (action.type === "fill" && action.ref && action.value !== undefined) {
        await fillLocator(refLocator(page, action.ref), action.value);
        results.push(`fill ${action.ref}: OK`);
      } else if (action.type === "type" && action.text) {
        await page.keyboard.type(action.text, { delay: 50 });
        results.push(`type: OK`);
      } else if (action.type === "press" && action.key) {
        await page.keyboard.press(action.key);
        results.push(`press ${action.key}: OK`);
      } else if (action.type === "select" && action.ref && action.value) {
        await refLocator(page, action.ref).selectOption(action.value, { timeout: ACTION_TIMEOUT });
        results.push(`select ${action.ref}: OK`);
      } else if (action.type === "check" && action.ref) {
        await refLocator(page, action.ref).check({ timeout: ACTION_TIMEOUT });
        results.push(`check ${action.ref}: OK`);
      } else if (action.type === "uncheck" && action.ref) {
        await refLocator(page, action.ref).uncheck({ timeout: ACTION_TIMEOUT });
        results.push(`uncheck ${action.ref}: OK`);
      } else if (action.type === "wait") {
        await page.waitForTimeout(action.timeout || 1000);
        results.push(`wait ${action.timeout || 1000}ms: OK`);
      }
      await page.waitForTimeout(300);
    } catch (e: any) {
      results.push(`${action.type} ${action.ref || ""}: FAIL — ${e.message?.slice(0, 60)}`);
    }
  }
  return { content: [{ type: "text", text: `Batch (${actions.length} actions):\n${results.map(r => "  " + r).join("\n")}` }] };
});

regTool("fill_form", "Fill multiple form fields and optionally submit.", {
  fields: z.array(z.object({
    ref: z.string().describe("Element ref from snapshot"),
    value: z.string().describe("Value to fill"),
  })),
  submit_ref: z.string().optional().describe("Ref of submit button to click after filling"),
}, async ({ fields, submit_ref }) => {
  const page = getPage();
  for (const f of fields) {
    await fillLocator(refLocator(page, f.ref), f.value);
  }
  let mode: ClickMode = "real";
  if (submit_ref) mode = await clickWithFallback(refLocator(page, submit_ref));
  await page.waitForTimeout(1000);
  return { content: [{ type: "text", text: `Filled ${fields.length} fields${submit_ref ? " + submitted" : ""}. URL: ${page.url()}${clickNote(mode)}` }] };
});

regTool("login_classic",
  "Composite login for classic email→password forms (Google, Microsoft, generic SSO). " +
  "Auto-detects the email field, clicks Next/Continue on multi-step forms, fills the password, submits, " +
  "and optionally enters a TOTP 2FA code. Collapses the usual 5–8 fill/click/snapshot calls into one. " +
  "Heuristic — if a form is unusual, fall back to individual fill/click tools. Returns the step log + a fresh snapshot.",
  {
    email: z.string().describe("Email / username to fill."),
    password: z.string().describe("Password to fill."),
    totp_secret: z.string().default("").describe("Base32 TOTP secret — a 6-digit code is generated if a 2FA field appears."),
    totp_code: z.string().default("").describe("Pre-computed 6-digit 2FA code (overrides totp_secret)."),
    submit_after_email: z.boolean().default(true).describe("Click Next/Continue after the email (Google/Microsoft multi-step)."),
    step_timeout_ms: z.number().default(8000).describe("Max wait for each step's field to appear."),
  },
  async ({ email, password, totp_secret, totp_code, submit_after_email, step_timeout_ms }) => {
    const page = getPage();
    const log: string[] = [];
    const EMAIL_SEL = 'input[type="email"], input[name="loginfmt"], input#identifierId, input[autocomplete="username"], input[name*="email" i], input[name*="user" i], input[id*="email" i], input[id*="user" i]';
    const PW_SEL = 'input[type="password"], input[name="passwd"], input[name="Passwd"], input[autocomplete="current-password"]';
    const NEXT_SEL = 'button[type="submit"], input[type="submit"], #idSIButton9, button:has-text("Next"), button:has-text("Continue"), button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Berikutnya"), button:has-text("Lanjut"), button:has-text("Masuk")';
    const TOTP_SEL = 'input[name="otc"], input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="code" i], input[inputmode="numeric"]';

    const finish = async (note: string) => {
      const snap = await snapshotPage(page);
      return { content: [{ type: "text" as const, text: `login_classic: ${note}\nsteps: ${log.join(" → ") || "(none)"}\n\n${snap}` }] };
    };

    // 1. Email field
    try {
      const ef = page.locator(EMAIL_SEL).first();
      await ef.waitFor({ state: "visible", timeout: step_timeout_ms });
      // fillLocator, not fill — a pre-filled email field would otherwise be
      // appended to ("olduser@x.comnewuser@x.com") on Firefox.
      await fillLocator(ef, email);
      log.push("email filled");
    } catch { return finish("FAILED — email field not found"); }

    // 2. Next/Continue (multi-step forms)
    if (submit_after_email) {
      try {
        const nb = page.locator(NEXT_SEL).first();
        if (await nb.count() && await nb.isVisible()) { await clickWithFallback(nb); log.push("clicked Next"); }
      } catch {}
      await page.waitForTimeout(1200);
    }

    // 3. Password field
    try {
      const pf = page.locator(PW_SEL).first();
      await pf.waitFor({ state: "visible", timeout: step_timeout_ms });
      await fillLocator(pf, password);
      log.push("password filled");
    } catch { return finish("FAILED — password field not found after email step"); }

    // 4. Submit password
    try {
      const sb = page.locator(NEXT_SEL).first();
      if (await sb.count() && await sb.isVisible()) { await clickWithFallback(sb); log.push("submitted"); }
      else { await page.keyboard.press("Enter"); log.push("submitted (Enter)"); }
    } catch { try { await page.keyboard.press("Enter"); } catch {} }
    await page.waitForTimeout(1500);

    // 5. TOTP / 2FA (optional)
    const code = totp_code || (totp_secret ? totpFromSecret(totp_secret) : "");
    if (code) {
      try {
        const tf = page.locator(TOTP_SEL).first();
        await tf.waitFor({ state: "visible", timeout: 4000 });
        await fillLocator(tf, code);
        log.push(`2FA code filled (${code})`);
        const sb = page.locator(NEXT_SEL).first();
        if (await sb.count() && await sb.isVisible()) await clickWithFallback(sb);
        else await page.keyboard.press("Enter");
        await page.waitForTimeout(1500);
      } catch { log.push("2FA field not shown — skipped"); }
    }

    return finish("done");
  });

regTool("navigate_and_snapshot", "Navigate to URL then return snapshot — combined in one call.", {
  url: z.string(),
  wait_until: z.enum(["domcontentloaded", "load", "networkidle"]).default("domcontentloaded"),
}, async ({ url, wait_until }) => {
  const page = getPage();
  await page.goto(url, { waitUntil: wait_until, timeout: 30000 });
  await page.waitForTimeout(1500);
  const text = await snapshotPage(page);
  return { content: [{ type: "text", text }] };
});

// ── Tools: Element Inspection ──────────────────────────────────────────────

regTool("inspect_element", "Get detailed info about an element (tag, attributes, bounding box, styles).", {
  ref: z.string(),
}, async ({ ref }) => {
  const page = getPage();
  const info = await refLocator(page, ref).evaluate((el: any) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const attrs: Record<string, string> = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    return {
      tag: el.tagName.toLowerCase(), id: el.id, className: el.className,
      text: (el.innerText || "").slice(0, 200), value: el.value || "",
      attrs, rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      visible: cs.display !== "none" && cs.visibility !== "hidden",
      fontSize: cs.fontSize, color: cs.color, bg: cs.backgroundColor,
    };
  });
  return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
});

regTool("get_attribute", "Get a specific attribute value from an element.", {
  ref: z.string(), attribute: z.string(),
}, async ({ ref, attribute }) => {
  const page = getPage();
  const val = await refLocator(page, ref).getAttribute(attribute);
  return { content: [{ type: "text", text: `${attribute}=${val}` }] };
});

regTool("query_selector_all", "Query elements by CSS selector, return text/attributes of all matches.", {
  selector: z.string(),
  attribute: z.string().default("").describe("Attribute to extract (empty = innerText)"),
  limit: z.number().default(20),
}, async ({ selector, attribute, limit }) => {
  const page = getPage();
  const results = await page.evaluate(`(() => {
    var attrName = ${jsStr(attribute)};
    var els = document.querySelectorAll(${jsStr(selector)});
    var out = [];
    for (var i = 0; i < Math.min(els.length, ${limit}); i++) {
      out.push({
        i: i,
        text: (els[i].innerText || '').trim().slice(0, 100),
        attr: attrName ? (els[i].getAttribute(attrName) || '') : '',
        tag: els[i].tagName.toLowerCase()
      });
    }
    return { total: els.length, items: out };
  })()`);
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
});

regTool("get_links", "Get all links on the page with URL and text.", {
  filter: z.string().default("").describe("Filter links by URL pattern (empty = all)"),
}, async ({ filter }) => {
  const page = getPage();
  const links = await page.evaluate(`(() => {
    var filter = ${jsStr(filter)};
    var links = document.querySelectorAll('a[href]');
    var out = [];
    for (var i = 0; i < links.length; i++) {
      var href = links[i].href || '';
      var text = (links[i].innerText || '').trim().slice(0, 80);
      if (!text && !href) continue;
      if (filter && href.indexOf(filter) === -1) continue;
      out.push({ text: text, href: href.slice(0, 150) });
    }
    return out;
  })()`);
  const arr = links as any[];
  const lines = arr.slice(0, 50).map((l: any) => `  ${l.text || "(no text)"} → ${l.href}`);
  return { content: [{ type: "text", text: `Links (${arr.length}):\n${lines.join("\n")}` }] };
});

// ── Tools: Storage ─────────────────────────────────────────────────────────

regTool("localstorage_get", "Get all localStorage data or a specific key.", {
  key: z.string().default("").describe("Key to get (empty = all)"),
}, async ({ key }) => {
  const page = getPage();
  if (key) {
    const val = await page.evaluate(`localStorage.getItem(${jsStr(key)})`);
    return { content: [{ type: "text", text: `${key}=${val}` }] };
  }
  const all = await page.evaluate(`(() => { var o = {}; for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; })()`);
  return { content: [{ type: "text", text: JSON.stringify(all, null, 2) }] };
});

regTool("localstorage_set", "Set a localStorage item.", {
  key: z.string(), value: z.string(),
}, async ({ key, value }) => {
  const page = getPage();
  await page.evaluate(`localStorage.setItem(${jsStr(key)}, ${jsStr(value)})`);
  return { content: [{ type: "text", text: `localStorage set: ${key}` }] };
});

regTool("localstorage_clear", "Clear all localStorage.", {}, async () => {
  const page = getPage();
  await page.evaluate(`localStorage.clear()`);
  return { content: [{ type: "text", text: "localStorage cleared." }] };
});

regTool("sessionstorage_get", "Get all sessionStorage data or a specific key.", {
  key: z.string().default(""),
}, async ({ key }) => {
  const page = getPage();
  if (key) {
    const val = await page.evaluate(`sessionStorage.getItem(${jsStr(key)})`);
    return { content: [{ type: "text", text: `${key}=${val}` }] };
  }
  const all = await page.evaluate(`(() => { var o = {}; for (var i = 0; i < sessionStorage.length; i++) { var k = sessionStorage.key(i); o[k] = sessionStorage.getItem(k); } return o; })()`);
  return { content: [{ type: "text", text: JSON.stringify(all, null, 2) }] };
});

regTool("sessionstorage_set", "Set a sessionStorage item.", {
  key: z.string(), value: z.string(),
}, async ({ key, value }) => {
  const page = getPage();
  await page.evaluate(`sessionStorage.setItem(${jsStr(key)}, ${jsStr(value)})`);
  return { content: [{ type: "text", text: `sessionStorage set: ${key}` }] };
});

// ── Tools: Mouse XY ────────────────────────────────────────────────────────

regTool("mouse_click_xy", "Click at exact x,y coordinates. steps>0 adds interpolated pre-movement (human-like).", {
  x: z.number(), y: z.number(),
  button: z.enum(["left", "right", "middle"]).default("left"),
  steps: z.number().default(0).describe("Interpolation steps for pre-click movement (0=instant, 15-30=human-like)"),
}, async ({ x, y, button, steps }) => {
  const page = getPage();
  if (steps > 0) {
    await page.mouse.move(x, y, { steps });
    await page.waitForTimeout(80 + Math.random() * 60);
  }
  await page.mouse.click(x, y, { button });
  await page.waitForTimeout(500);
  return { content: [{ type: "text", text: `Clicked at (${x}, ${y}) button=${button} steps=${steps}` }] };
});

regTool("mouse_move", "Move mouse to x,y. steps>0 interpolates path (human-like).", {
  x: z.number(), y: z.number(),
  steps: z.number().default(0).describe("Interpolation steps (0=instant jump, 15-30=smooth)"),
}, async ({ x, y, steps }) => {
  const page = getPage();
  await page.mouse.move(x, y, steps > 0 ? { steps } : undefined);
  return { content: [{ type: "text", text: `Mouse moved to (${x}, ${y}) steps=${steps}` }] };
});

regTool("click_turnstile", "Auto-solve Cloudflare Interactive Turnstile checkbox. Locates the widget via in-page selectors AND the Playwright frame API (handles closed shadow roots that document.querySelector misses), polls for render, skips if already solved, then does a humanized real-mouse click with retries + small nudge, verifying the cf-turnstile-response token after each attempt. Managed Challenge full-page interstitials still need mcp-stealth-chrome.", {
  offset_x: z.number().default(30).describe("Pixels from widget left edge to the checkbox (calibrated for CF checkbox)"),
  offset_y: z.number().optional().describe("Vertical offset from widget top (default = height/2)"),
  wait_render_ms: z.number().default(500).describe("Wait before first detection to let widget render"),
  max_attempts: z.number().default(3).describe("Max click attempts (small vertical nudge between tries) until token appears"),
}, async ({ offset_x, offset_y, wait_render_ms, max_attempts }) => {
  const page = getPage();
  await page.waitForTimeout(wait_render_ms);

  type TSCoords = { found: string; left: number; top: number; width: number; height: number };

  // Locate widget: in-page querySelector (light DOM) first, then Playwright frame
  // API (the Turnstile <iframe> often sits in a CLOSED shadow root, invisible to
  // document.querySelector but still tracked by page.frames()).
  const locate = async (): Promise<TSCoords | null> => {
    const viaSel = await page.evaluate(() => {
      const sels = [
        'iframe[src*="challenges.cloudflare.com"]',
        'iframe[src*="turnstile"]',
        '[data-testid*="challenge-widget"]',
        '[data-testid*="turnstile"]',
        '[data-sitekey]',
        '.cf-turnstile',
      ];
      for (const sel of sels) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) continue;
        let r = el.getBoundingClientRect();
        if (r.width < 50 || r.height < 20) continue;  // size is scroll-invariant — gate first
        el.scrollIntoView({ block: "center", inline: "center" });  // below-fold widget → into view so the click lands
        r = el.getBoundingClientRect();  // re-read position after scroll
        return { found: sel, left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      }
      return null;
    }).catch(() => null);
    if (viaSel) return viaSel as TSCoords;

    for (const frame of page.frames()) {
      const u = frame.url() || "";
      const n = frame.name() || "";
      if (!(/challenges\.cloudflare\.com|turnstile/i.test(u) || /^cf-chl-widget/i.test(n))) continue;
      const el = await frame.frameElement().catch(() => null);
      if (!el) continue;
      await el.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
      const box = await el.boundingBox().catch(() => null);
      if (box && box.width >= 50 && box.height >= 20) {
        return { found: `frame:${n || u.slice(0, 40)}`, left: Math.round(box.x), top: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
      }
    }
    return null;
  };

  // Success signal: Turnstile injects the solved token into a hidden response field
  // (in the host page light DOM). Non-trivial length => solved.
  const isSolved = async (): Promise<boolean> => {
    return await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll(
        'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], input[name="g-recaptcha-response"]'
      )) as HTMLInputElement[];
      return inputs.some((i) => (i.value || "").length > 20);
    }).catch(() => false);
  };

  // Poll for the widget to render (~6s).
  let coords: TSCoords | null = null;
  for (let i = 0; i < 12 && !coords; i++) {
    coords = await locate();
    if (!coords) await page.waitForTimeout(500);
  }

  // Idempotent: if already solved, never click (a re-click can reset a solved widget).
  if (await isSolved()) {
    return { content: [{ type: "text", text: "Turnstile already solved (token present) — no click needed." }] };
  }

  if (!coords) {
    return { content: [{ type: "text", text: "Turnstile widget not found — selector + frame-API both missed. Likely a Managed Challenge interstitial (use mcp-stealth-chrome) or not rendered yet (retry with wait_render_ms=3000)." }] };
  }

  // Click with retries. Each attempt re-locates (widget can shift), applies a tiny
  // vertical nudge, then polls the token up to ~4s — so we break the instant it
  // solves and avoid re-clicking an already-solved widget.
  let solved = false;
  let lastTarget = "";
  const attempts = Math.max(1, max_attempts);
  for (let attempt = 0; attempt < attempts && !solved; attempt++) {
    const fresh = await locate();
    if (fresh) coords = fresh;
    if (!coords) break;
    const nudge = attempt === 0 ? 0 : (attempt % 2 === 1 ? -6 : 6);
    const targetX = coords.left + offset_x;
    const targetY = coords.top + (offset_y ?? Math.floor(coords.height / 2)) + nudge;
    lastTarget = `${targetX},${targetY}`;

    // Single pre-drift from off-target, then direct real-mouse click. Camoufox's
    // humanize layer handles path curvature + timing; extra Bezier hops are redundant.
    await page.mouse.move(targetX + 180, targetY - 80, { steps: 15 });
    await page.waitForTimeout(150);
    await page.mouse.click(targetX, targetY);

    for (let j = 0; j < 8 && !solved; j++) {
      await page.waitForTimeout(500);
      solved = await isSolved();
    }
  }

  return { content: [{ type: "text", text: `Turnstile ${solved ? "SOLVED ✓" : "clicked but token not detected"} at (${lastTarget}) via ${coords?.found ?? "?"}${solved ? "" : " — if still unsolved it may be a Managed Challenge (use mcp-stealth-chrome) or needs a screenshot to confirm 'Success!'"}` }] };
});

regTool("drag_and_drop", "Drag from one element to another.", {
  source_ref: z.string().describe("Ref of element to drag"),
  target_ref: z.string().describe("Ref of drop target"),
}, async ({ source_ref, target_ref }) => {
  const page = getPage();
  const src = refLocator(page, source_ref);
  const tgt = refLocator(page, target_ref);
  await src.dragTo(tgt, { timeout: ACTION_TIMEOUT });
  return { content: [{ type: "text", text: `Dragged ${source_ref} → ${target_ref}` }] };
});

// ── Tools: Frames/Iframes ──────────────────────────────────────────────────

regTool("list_frames", "List all frames/iframes in the page.", {}, async () => {
  const page = getPage();
  const frames = page.frames();
  const lines = frames.map((f, i) => `  [${i}] ${f.name() || "(unnamed)"} — ${f.url().slice(0, 100)}`);
  return { content: [{ type: "text", text: `Frames (${frames.length}):\n${lines.join("\n")}` }] };
});

regTool("frame_evaluate", "Execute JavaScript inside a specific frame/iframe.", {
  frame_name: z.string().default("").describe("Frame name (empty = by index)"),
  frame_index: z.number().default(0).describe("Frame index from list_frames"),
  expression: z.string(),
}, async ({ frame_name, frame_index, expression }) => {
  const page = getPage();
  const frame = frame_name
    ? page.frames().find(f => f.name() === frame_name)
    : page.frames()[frame_index];
  if (!frame) {
    const avail = page.frames().map((f, i) => `  [${i}] ${f.name() || "(unnamed)"} ${f.url()}`).join("\n");
    return {
      content: [{ type: "text", text: `Frame not found (${frame_name ? `name="${frame_name}"` : `index=${frame_index}`}). Available frames:\n${avail}` }],
      isError: true,
    };
  }
  const result = await frame.evaluate(expression);
  return { content: [{ type: "text", text: typeof result === "object" ? JSON.stringify(result, null, 2) : String(result) }] };
});

// ── Tools: Wait (extended) ─────────────────────────────────────────────────

regTool("wait_for_url", "Wait for URL to match a pattern.", {
  pattern: z.string().describe("URL substring or regex pattern"),
  timeout: z.number().default(15000),
}, async ({ pattern, timeout }) => {
  const page = getPage();
  // Treat as a regex ONLY when wrapped in /…/ (regex-literal form). A bare
  // leading slash like "/mail" is a path substring, not a regex — slicing both
  // ends off it used to silently drop the last char ("/mail" → "mai").
  const isRegexLiteral = pattern.length > 1 && pattern.startsWith("/") && pattern.endsWith("/");
  await page.waitForURL(isRegexLiteral ? new RegExp(pattern.slice(1, -1)) : `**/*${pattern}*`, { timeout });
  return { content: [{ type: "text", text: `URL matched pattern '${pattern}'. Current: ${page.url()}` }] };
});

regTool("wait_for_response", "Wait for a network response matching a URL pattern.", {
  url_pattern: z.string().describe("URL substring to match"),
  timeout: z.number().default(15000),
}, async ({ url_pattern, timeout }) => {
  const page = getPage();
  const resp = await page.waitForResponse(r => r.url().includes(url_pattern), { timeout });
  return { content: [{ type: "text", text: `Response: ${resp.status()} ${resp.url().slice(0, 120)}` }] };
});

// ── Tools: Viewport ────────────────────────────────────────────────────────

regTool("get_viewport_size", "Get current viewport dimensions.", {}, async () => {
  const page = getPage();
  const size = page.viewportSize();
  return { content: [{ type: "text", text: `Viewport: ${size?.width || "?"}x${size?.height || "?"}` }] };
});

regTool("set_viewport_size", "Set viewport width and height.", {
  width: z.number(), height: z.number(),
}, async ({ width, height }) => {
  const page = getPage();
  await page.setViewportSize({ width, height });
  return { content: [{ type: "text", text: `Viewport set to ${width}x${height}` }] };
});

// ── Tools: Accessibility ───────────────────────────────────────────────────

regTool("accessibility_snapshot", "Get accessibility tree snapshot — compact view of page structure for LLM understanding.", {}, async () => {
  const page = getPage();
  const snap = await page.evaluate(`(() => {
    function walk(el, depth) {
      if (depth > 4) return null;
      var role = el.getAttribute ? (el.getAttribute('role') || el.tagName.toLowerCase()) : '';
      var name = el.getAttribute ? (el.getAttribute('aria-label') || el.innerText || '').trim().slice(0, 60) : '';
      var node = { role: role, name: name };
      if (el.children && el.children.length > 0 && depth < 3) {
        node.children = [];
        for (var i = 0; i < Math.min(el.children.length, 20); i++) {
          var child = walk(el.children[i], depth + 1);
          if (child && child.name) node.children.push(child);
        }
        if (node.children.length === 0) delete node.children;
      }
      return node;
    }
    return walk(document.body, 0);
  })()`);
  const text = JSON.stringify(snap, null, 2);
  if (text.length > 8000) return { content: [{ type: "text", text: text.slice(0, 8000) + "\n... (truncated)" }] };
  return { content: [{ type: "text", text }] };
});

// ── Tools: Debug & Health ──────────────────────────────────────────────────

regTool("server_status", "Health check — verify server, browser status, active tabs.", {}, async () => {
  return { content: [{ type: "text", text: JSON.stringify({
    browser_up: browserUp,
    active_tabs: pages.length,
    active_page: activePage,
    current_url: browserUp && pages.length > 0 ? pages[activePage]?.url() : null,
    profile_dir: PROFILE_DIR,
    screenshot_dir: SCREENSHOT_DIR,
  }, null, 2) }] };
});

regTool("get_page_errors",
  "Get uncaught JavaScript errors + unhandled promise rejections from the current page. " +
  "Captured by a hook installed at browser_launch, so the buffer resets on every navigation " +
  "(read it before navigating away). Max 100 entries per page load.",
  {}, async () => {
  const page = getPage();
  const errors = await page.evaluate(`(() => {
    if (!window.__mcp_errors) return null;
    return window.__mcp_errors.slice(-20);
  })()`) as any[] | null;
  if (errors === null) {
    return { content: [{ type: "text", text: "Error hook not installed on this page — it is added at browser_launch and applies from the next navigation onward. Navigate (or reload) and retry." }] };
  }
  if (!errors.length) return { content: [{ type: "text", text: "No JS errors captured on this page load." }] };
  return { content: [{ type: "text", text: `Page errors (${errors.length}):\n${JSON.stringify(errors, null, 2)}` }] };
});

regTool("inject_init_script", "Inject a script that runs before every page load.", {
  script: z.string().describe("JavaScript code to inject"),
}, async ({ script }) => {
  if (!browserContext) throw new Error("Browser not running. Call browser_launch first.");
  await browserContext.addInitScript(script);
  return { content: [{ type: "text", text: "Init script injected. Will run on every new page/navigation." }] };
});

// ── Tools: Export ──────────────────────────────────────────────────────────

regTool("export_har",
  "Export captured network traffic as a HAR 1.2 file (openable in DevTools/other HAR viewers). " +
  "Requires network_start first; headers and bodies are only included when network_start(capture_bodies=true) was used.",
  {
    path: z.string().default(""),
    limit: z.number().default(200).describe("Max (most recent) requests to include."),
  }, async ({ path: harPath, limit }) => {
  const page = getPage();
  const target = harPath ? resolveOutPath(harPath) : join(SCREENSHOT_DIR, "network.har");
  // HAR wants [{name, value}] pairs, not an object map.
  const harHeaders = (h?: Record<string, string>) =>
    h ? Object.entries(h).map(([name, value]) => ({ name, value: String(value) })) : [];
  const rows = networkRequests.slice(-Math.max(1, limit));
  const entries = rows.map(r => ({
    startedDateTime: new Date(r.ts).toISOString(),
    time: 0,                                    // per-request timings aren't captured
    request: {
      method: r.method,
      url: r.url,
      httpVersion: "HTTP/1.1",
      headers: harHeaders(r.reqHeaders),
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: r.reqBody ? Buffer.byteLength(r.reqBody) : -1,
      ...(r.reqBody
        ? { postData: { mimeType: r.reqHeaders?.["content-type"] || "", text: r.reqBody } }
        : {}),
    },
    response: {
      status: r.status,
      statusText: "",
      httpVersion: "HTTP/1.1",
      headers: harHeaders(r.resHeaders),
      cookies: [],
      content: {
        size: r.resBody ? Buffer.byteLength(r.resBody) : 0,
        mimeType: r.mimeType || "",
        ...(r.resBody ? { text: r.resBody } : {}),
      },
      redirectURL: "",
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: -1, wait: -1, receive: -1 },
    _resourceType: r.resourceType || "",
  }));
  const har = {
    log: {
      version: "1.2",
      creator: { name: "mcp-camoufox", version: PKG_VERSION },
      pages: [{
        startedDateTime: new Date(rows[0]?.ts ?? Date.now()).toISOString(),
        id: "page_1",
        title: page.url(),
        pageTimings: { onContentLoad: -1, onLoad: -1 },
      }],
      entries: entries.map(e => ({ ...e, pageref: "page_1" })),
    },
  };
  writeFileSync(target, JSON.stringify(har, null, 2));
  const bodyNote = networkCaptureBodies ? "" : " (no headers/bodies — restart with network_start capture_bodies=true)";
  return { content: [{ type: "text", text: `HAR exported: ${target} (${entries.length} entries)${bodyNote}` }] };
});

// ── Tools: Scraping / Extraction ───────────────────────────────────────────

regTool("detect_content_pattern", "Auto-detect repeated content patterns (cards, listings, rows) and suggest CSS selectors. Run this BEFORE extract_structured to find the right selectors.", {
  min_items: z.number().default(3).describe("Minimum repeated items to detect as pattern"),
}, async ({ min_items }) => {
  const page = getPage();
  const patterns = await page.evaluate(`(() => {
    // Count children with same tag+class per parent
    var candidates = [];
    var parents = document.querySelectorAll('main, [role="main"], section, div, ul, ol, tbody');
    for (var p = 0; p < parents.length; p++) {
      var parent = parents[p];
      var childMap = {};
      for (var c = 0; c < parent.children.length; c++) {
        var child = parent.children[c];
        var key = child.tagName;
        if (child.className) key += '.' + child.className.split(' ').filter(function(c){return c.length>0}).slice(0,2).join('.');
        if (!childMap[key]) childMap[key] = { count: 0, tag: child.tagName.toLowerCase(), cls: child.className, sample: '' };
        childMap[key].count++;
        if (!childMap[key].sample) childMap[key].sample = (child.innerText || '').trim().slice(0, 150);
      }
      var keys = Object.keys(childMap);
      for (var k = 0; k < keys.length; k++) {
        if (childMap[keys[k]].count >= ${min_items}) {
          var info = childMap[keys[k]];
          // Build selector
          var sel = info.tag;
          if (info.cls) {
            var classes = info.cls.split(' ').filter(function(c){return c.length > 0 && c.length < 40}).slice(0,2);
            if (classes.length > 0) sel = info.tag + '.' + classes.join('.');
          }
          // Find child elements for field suggestions
          var firstItem = parent.querySelector(sel);
          var fieldHints = [];
          if (firstItem) {
            var links = firstItem.querySelectorAll('a[href]');
            if (links.length > 0) fieldHints.push({ name: 'url', selector: 'a', attribute: 'href', sample: links[0].href.slice(0, 100) });
            var headings = firstItem.querySelectorAll('h1,h2,h3,h4,h5,h6');
            if (headings.length > 0) fieldHints.push({ name: 'title', selector: headings[0].tagName.toLowerCase(), attribute: '', sample: headings[0].innerText.trim().slice(0, 60) });
            var imgs = firstItem.querySelectorAll('img[src]');
            if (imgs.length > 0) fieldHints.push({ name: 'image', selector: 'img', attribute: 'src', sample: imgs[0].src.slice(0, 80) });
            // Find text-heavy spans/divs
            var texts = firstItem.querySelectorAll('span, p, div');
            var textItems = [];
            for (var t = 0; t < texts.length; t++) {
              var txt = texts[t].innerText.trim();
              if (txt.length > 5 && txt.length < 100 && texts[t].children.length === 0) {
                var tSel = texts[t].tagName.toLowerCase();
                if (texts[t].className) tSel += '.' + texts[t].className.split(' ').filter(function(c){return c.length>0&&c.length<40}).slice(0,1).join('.');
                textItems.push({ selector: tSel, sample: txt.slice(0, 60) });
              }
            }
            for (var ti = 0; ti < Math.min(textItems.length, 3); ti++) {
              fieldHints.push({ name: 'field_' + ti, selector: textItems[ti].selector, attribute: '', sample: textItems[ti].sample });
            }
          }
          candidates.push({
            selector: sel,
            count: info.count,
            sample_text: info.sample.slice(0, 100),
            suggested_fields: fieldHints
          });
        }
      }
    }
    // Sort by count desc, deduplicate by selector
    candidates.sort(function(a,b){ return b.count - a.count; });
    var seen = {};
    var unique = [];
    for (var u = 0; u < candidates.length; u++) {
      if (!seen[candidates[u].selector]) {
        seen[candidates[u].selector] = true;
        unique.push(candidates[u]);
      }
    }
    return unique.slice(0, 10);
  })()`);
  const arr = patterns as any[];
  if (arr.length === 0) {
    return { content: [{ type: "text", text: "No repeated content patterns detected. Try scrolling down to load more content." }] };
  }
  let text = `Detected ${arr.length} content pattern(s):\n\n`;
  for (const p of arr) {
    text += `--- ${p.count} items: ${p.selector} ---\n`;
    text += `Sample: "${p.sample_text}"\n`;
    if (p.suggested_fields?.length) {
      text += `Suggested extract_structured call:\n`;
      text += `  container_selector: "${p.selector}"\n`;
      text += `  fields:\n`;
      for (const f of p.suggested_fields) {
        text += `    - {name: "${f.name}", selector: "${f.selector}"${f.attribute ? `, attribute: "${f.attribute}"` : ''}} → "${f.sample}"\n`;
      }
    }
    text += `\n`;
  }
  return { content: [{ type: "text", text }] };
});

regTool("extract_structured", "Extract structured data from repeated elements (cards, rows, listings). Auto-deduplicates, filters empty items, extracts direct text only. Use detect_content_pattern first to find correct selectors.", {
  container_selector: z.string().describe("CSS selector for each repeated item. Use detect_content_pattern to find this."),
  fields: z.array(z.object({
    name: z.string().describe("Field name in output"),
    selector: z.string().describe("CSS selector within each item"),
    attribute: z.string().default("").describe("Attribute to extract (empty = direct text only)"),
  })).describe("Fields to extract from each item"),
  limit: z.number().default(50).describe("Max items to extract"),
  deduplicate_by: z.string().default("").describe("Field name to deduplicate by (empty = auto)"),
  direct_text_only: z.boolean().default(true).describe("Extract only direct text of matched element, not children text (prevents field mixing)"),
}, async ({ container_selector, fields, limit, deduplicate_by, direct_text_only }) => {
  const page = getPage();
  const fieldsDef = JSON.stringify(fields);
  const results = await page.evaluate(`(() => {
    // Helper: get direct text only (no children text) to prevent field mixing
    function directText(el) {
      var text = '';
      for (var n = 0; n < el.childNodes.length; n++) {
        if (el.childNodes[n].nodeType === 3) text += el.childNodes[n].textContent;
      }
      text = text.trim();
      // If direct text empty, fall back to first line of innerText
      if (!text) {
        var lines = (el.innerText || '').trim().split('\\n');
        text = lines[0] || '';
      }
      return text.trim();
    }

    // Get ALL matching containers, then filter to only top-level (not nested)
    var containerSel = ${jsStr(container_selector)};
    var allContainers = document.querySelectorAll(containerSel);
    var containers = [];
    for (var c = 0; c < allContainers.length; c++) {
      var isNested = false;
      var parent = allContainers[c].parentElement;
      while (parent) {
        if (parent.matches && parent.matches(containerSel)) {
          isNested = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (!isNested) containers.push(allContainers[c]);
    }

    var fields = ${fieldsDef};
    var directOnly = ${direct_text_only};
    var out = [];
    var seenKeys = {};
    var dedup = ${jsStr(deduplicate_by)};

    for (var i = 0; i < Math.min(containers.length, ${limit * 2}); i++) {
      var item = {};
      var nonEmptyCount = 0;

      for (var j = 0; j < fields.length; j++) {
        var f = fields[j];
        var el = containers[i].querySelector(f.selector);
        if (el) {
          var val;
          if (f.attribute) {
            val = el.getAttribute(f.attribute) || '';
          } else if (directOnly) {
            val = directText(el);
          } else {
            val = (el.innerText || '').trim();
          }
          item[f.name] = val;
          if (val) nonEmptyCount++;
        } else {
          item[f.name] = '';
        }
      }

      // P0: Skip items where all fields are empty
      if (nonEmptyCount === 0) continue;

      // P0: Deduplicate
      var dedupKey = '';
      if (dedup && item[dedup]) {
        dedupKey = item[dedup];
      } else {
        for (var d = 0; d < fields.length; d++) {
          if (item[fields[d].name]) { dedupKey = item[fields[d].name]; break; }
        }
      }
      if (dedupKey && seenKeys[dedupKey]) continue;
      if (dedupKey) seenKeys[dedupKey] = true;

      out.push(item);
      if (out.length >= ${limit}) break;
    }

    return {
      total_on_page: allContainers.length,
      top_level: containers.length,
      unique_extracted: out.length,
      items: out
    };
  })()`);
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
});

regTool("extract_table", "Extract data from an HTML table as JSON array.", {
  selector: z.string().default("table").describe("CSS selector for the table"),
  limit: z.number().default(100).describe("Max rows"),
}, async ({ selector, limit }) => {
  const page = getPage();
  const results = await page.evaluate(`(() => {
    var table = document.querySelector(${jsStr(selector)});
    if (!table) return { error: 'Table not found' };
    var headers = [];
    var ths = table.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td');
    for (var i = 0; i < ths.length; i++) headers.push(ths[i].innerText.trim());
    var rows = table.querySelectorAll('tbody tr, tr');
    var out = [];
    var start = headers.length > 0 ? 1 : 0;
    for (var r = start; r < Math.min(rows.length, ${limit} + start); r++) {
      var cells = rows[r].querySelectorAll('td, th');
      var row = {};
      for (var c = 0; c < cells.length; c++) {
        var key = headers[c] || ('col_' + c);
        var link = cells[c].querySelector('a');
        row[key] = cells[c].innerText.trim();
        if (link) row[key + '_url'] = link.href;
      }
      out.push(row);
    }
    return { headers: headers, total_rows: rows.length - start, extracted: out.length, rows: out };
  })()`);
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
});

regTool("scrape_page", "Smart page scraper — auto-detect and extract main content, links, metadata. Strips nav/footer noise.", {
  include_links: z.boolean().default(true),
  include_meta: z.boolean().default(true),
  max_text_length: z.number().default(8000).describe("Max text chars (truncates at paragraph boundary)"),
  only_main_content: z.boolean().default(true).describe("Strip nav, header, footer, sidebar — extract only main content area"),
}, async ({ include_links, include_meta, max_text_length, only_main_content }) => {
  const page = getPage();
  const data = await page.evaluate(`(() => {
    var result = {};
    result.title = document.title;
    result.url = location.href;

    // Meta
    if (${include_meta}) {
      var metas = {};
      var metaEls = document.querySelectorAll('meta[name], meta[property]');
      for (var i = 0; i < metaEls.length; i++) {
        var key = metaEls[i].getAttribute('name') || metaEls[i].getAttribute('property');
        metas[key] = metaEls[i].getAttribute('content') || '';
      }
      result.meta = metas;
    }

    // Find main content area
    var textSource;
    if (${only_main_content}) {
      textSource = document.querySelector('main, [role="main"], #main-content, .main-content, #content, .content');
      // Exclude nav/footer/sidebar from the source
      if (textSource) {
        var clone = textSource.cloneNode(true);
        var noise = clone.querySelectorAll('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .sidebar, .nav, .footer, .header');
        for (var n = 0; n < noise.length; n++) noise[n].remove();
        var fullText = clone.innerText.trim();
      } else {
        textSource = document.body;
        var fullText = textSource.innerText.trim();
      }
    } else {
      textSource = document.body;
      var fullText = textSource.innerText.trim();
    }

    // Smart truncation: cut at paragraph/newline boundary, not mid-word
    var totalLen = fullText.length;
    if (fullText.length > ${max_text_length}) {
      var cutText = fullText.slice(0, ${max_text_length});
      var lastNewline = cutText.lastIndexOf('\\n');
      if (lastNewline > ${max_text_length} * 0.8) {
        cutText = cutText.slice(0, lastNewline);
      }
      result.text = cutText;
      result.truncated = true;
      result.total_text_length = totalLen;
    } else {
      result.text = fullText;
      result.truncated = false;
      result.total_text_length = totalLen;
    }

    // Links from main content area
    if (${include_links}) {
      var linkSource = textSource || document.body;
      var links = linkSource.querySelectorAll('a[href]');
      var linkList = [];
      for (var j = 0; j < Math.min(links.length, 50); j++) {
        var text = (links[j].innerText || '').trim().slice(0, 80);
        if (text) linkList.push({ text: text, href: links[j].href });
      }
      result.links = linkList;
    }

    // Headings
    var headingSource = textSource || document.body;
    var headings = [];
    var hs = headingSource.querySelectorAll('h1, h2, h3');
    for (var k = 0; k < Math.min(hs.length, 20); k++) {
      headings.push({ level: hs[k].tagName, text: hs[k].innerText.trim().slice(0, 100) });
    }
    result.headings = headings;

    return result;
  })()`);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// ── Tools: Compound (reduce round-trips) ───────────────────────────────────

regTool(
  "wait_and_snapshot",
  "Wait for selector/text then return snapshot. Combines wait_for + browser_snapshot in one call.",
  {
    selector: z.string().default("").describe("CSS selector to wait for"),
    text: z.string().default("").describe("Text to wait for"),
    state: z.enum(["visible", "hidden", "attached", "detached"]).default("visible"),
    timeout: z.number().default(10000),
  },
  async ({ selector, text, state, timeout }) => {
    const page = getPage();
    if (selector) {
      await page.locator(selector).first().waitFor({ state, timeout });
    } else if (text) {
      await page.getByText(text).first().waitFor({ state, timeout });
    }
    const snap = await snapshotPage(page);
    return { content: [{ type: "text", text: snap }] };
  }
);

regTool("back_and_snapshot", "Navigate back + return snapshot.", {}, async () => {
  const page = getPage();
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForTimeout(500);
  const snap = await snapshotPage(page);
  return { content: [{ type: "text", text: snap }] };
});

regTool("reload_and_snapshot", "Reload page + return snapshot.", {}, async () => {
  const page = getPage();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForTimeout(500);
  const snap = await snapshotPage(page);
  return { content: [{ type: "text", text: snap }] };
});

regTool(
  "click_and_snapshot",
  "Click element by ref + wait + return snapshot. Perfect for buttons that trigger navigation/dialog.",
  {
    ref: z.string().describe("Element ref from browser_snapshot"),
    wait_ms: z.number().default(1500).describe("Wait after click before snapshot"),
  },
  async ({ ref, wait_ms }) => {
    const page = getPage();
    const mode = await clickWithFallback(refLocator(page, ref));
    await page.waitForTimeout(wait_ms);
    const snap = await snapshotPage(page);
    return { content: [{ type: "text", text: (mode === "real" ? "" : `NOTE:${clickNote(mode)}\n\n`) + snap }] };
  }
);

// ── Tools: Smart Selectors (no snapshot needed) ────────────────────────────

regTool(
  "find_by_text",
  "Find elements by visible text — returns EVERY match (total + a ref and ancestor path per candidate), so you can tell whether the one you want is really the one you'd click. Skip browser_snapshot when you know the text.",
  {
    text: z.string().describe("Visible text to search for"),
    exact: z.boolean().default(true),
    within: z.string().default("").describe('Limit the search: "@dialog", "ref:e5", or a CSS selector.'),
    limit: z.number().default(8).describe("Max candidates to describe."),
  },
  async ({ text, exact, within, limit }) => {
    const page = getPage();
    const scope = within ? ` within=${within}` : "";
    let loc: any;
    try {
      loc = scopeRoot(page, within).getByText(text, { exact });
    } catch (e: any) {
      return { content: [{ type: "text", text: `Invalid within=${within}: ${e?.message || e}` }], isError: true };
    }
    const { total, items } = await describeMatches(loc, Math.max(1, limit));
    if (total === 0) {
      return { content: [{ type: "text", text: `No element found with text "${text}"${scope}` }] };
    }
    return {
      content: [{ type: "text", text: `${total} match(es) for text="${text}"${scope}${total > 1 ? " — pick deliberately, don't assume the first" : ""}:\n${candidateList(total, items)}` }],
    };
  }
);

regTool(
  "find_by_label",
  "Find input element by its label text (<label>). Returns ref + how many matched.",
  {
    label: z.string().describe("Label text (e.g. 'Email', 'Password')"),
    within: z.string().default("").describe('Limit the search: "@dialog", "ref:e5", or a CSS selector.'),
  },
  async ({ label, within }) => {
    const page = getPage();
    let loc: any;
    try {
      loc = scopeRoot(page, within).getByLabel(label);
    } catch (e: any) {
      return { content: [{ type: "text", text: `Invalid within=${within}: ${e?.message || e}` }], isError: true };
    }
    const count = await loc.count();
    if (count === 0) {
      return { content: [{ type: "text", text: `No input found with label "${label}"${within ? ` within=${within}` : ""}` }] };
    }
    if (count > 1) {
      const { total, items } = await describeMatches(loc);
      return { content: [{ type: "text", text: `${total} inputs match label "${label}" — choose one by ref:\n${candidateList(total, items)}` }] };
    }
    const info = await loc.first().evaluate((el: any) => {
      const ref = 'l' + (Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36));
      el.setAttribute('data-mcp-ref', ref);
      return {
        ref,
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        name: el.name || '',
        placeholder: el.placeholder || '',
        value: el.value || '',
      };
    });
    return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
  }
);

regTool(
  "find_by_placeholder",
  "Find input by placeholder text. Returns ref + how many matched.",
  {
    placeholder: z.string(),
    within: z.string().default("").describe('Limit the search: "@dialog", "ref:e5", or a CSS selector.'),
  },
  async ({ placeholder, within }) => {
    const page = getPage();
    let loc: any;
    try {
      loc = scopeRoot(page, within).getByPlaceholder(placeholder);
    } catch (e: any) {
      return { content: [{ type: "text", text: `Invalid within=${within}: ${e?.message || e}` }], isError: true };
    }
    const count = await loc.count();
    if (count === 0) {
      return { content: [{ type: "text", text: `No input with placeholder "${placeholder}"${within ? ` within=${within}` : ""}` }] };
    }
    if (count > 1) {
      const { total, items } = await describeMatches(loc);
      return { content: [{ type: "text", text: `${total} inputs match placeholder "${placeholder}" — choose one by ref:\n${candidateList(total, items)}` }] };
    }
    const info = await loc.first().evaluate((el: any) => {
      const ref = 'p' + (Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36));
      el.setAttribute('data-mcp-ref', ref);
      return {
        ref, tag: el.tagName.toLowerCase(), type: el.type || '', placeholder: el.placeholder || '',
      };
    });
    return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
  }
);

// ── Tools: Cookie Portability ──────────────────────────────────────────────

regTool(
  "cookie_export",
  "Export all cookies as JSON string. Use with cookie_import to transfer session.",
  {
    domain: z.string().default("").describe("Filter by domain (empty = all)"),
  },
  async ({ domain }) => {
    if (!browserContext) throw new Error("Browser not running. Call browser_launch first.");
    let cookies = await browserContext.cookies();
    if (domain) cookies = cookies.filter(c => c.domain.includes(domain));
    return { content: [{ type: "text", text: JSON.stringify(cookies, null, 2) }] };
  }
);

regTool(
  "cookie_import",
  "Import cookies from JSON (from cookie_export). Restores session state.",
  {
    cookies_json: z.string().describe("JSON array of cookies"),
  },
  async ({ cookies_json }) => {
    if (!browserContext) throw new Error("Browser not running. Call browser_launch first.");
    let cookies: any[];
    try {
      cookies = JSON.parse(cookies_json);
      if (!Array.isArray(cookies)) throw new Error("not an array");
    } catch (e: any) {
      return { content: [{ type: "text", text: `Invalid cookies JSON: ${e.message}` }] };
    }
    await browserContext.addCookies(cookies);
    return { content: [{ type: "text", text: `Imported ${cookies.length} cookies.` }] };
  }
);

// ── Tools: Page Stats (debug/decision) ─────────────────────────────────────

regTool(
  "page_stats",
  "Page statistics: element count, size, load metrics. Use to decide extraction strategy.",
  {},
  async () => {
    const page = getPage();
    const stats = await page.evaluate(`(() => {
      var all = document.querySelectorAll('*').length;
      var interactive = document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"]').length;
      var images = document.querySelectorAll('img').length;
      var forms = document.querySelectorAll('form').length;
      var iframes = document.querySelectorAll('iframe').length;
      var scripts = document.querySelectorAll('script').length;
      var bodyTextLen = (document.body.innerText || '').length;
      var htmlLen = document.documentElement.outerHTML.length;
      var perf = window.performance && window.performance.timing ? {
        domComplete: window.performance.timing.domComplete - window.performance.timing.navigationStart,
        loadEnd: window.performance.timing.loadEventEnd - window.performance.timing.navigationStart,
      } : null;
      return {
        url: location.href,
        title: document.title,
        total_elements: all,
        interactive_elements: interactive,
        images: images,
        forms: forms,
        iframes: iframes,
        scripts: scripts,
        body_text_length: bodyTextLen,
        html_size: htmlLen,
        performance_ms: perf,
        recommendation: all > 3000 ? 'Use extract_structured or scrape_page (heavy page)' : 'browser_snapshot OK',
      };
    })()`);
    return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
  }
);

// ── Tools: Storage State (Session Reuse) ───────────────────────────────────

regTool("storage_state_save", "Save cookies + localStorage to a JSON file. Reload via storage_state_load on a fresh browser to skip login/CF entirely.", {
  path: z.string().describe("Output file path (e.g. ~/.camoufox-mcp/sessions/site.json)"),
}, async ({ path }) => {
  const page = getPage();
  const ctx = page.context();
  const cookies = await ctx.cookies();
  const origins = await page.evaluate(`(() => {
    var data = { local: {}, session: {} };
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i); data.local[k] = localStorage.getItem(k);
    }
    for (var j = 0; j < sessionStorage.length; j++) {
      var k = sessionStorage.key(j); data.session[k] = sessionStorage.getItem(k);
    }
    return { url: location.href, origin: location.origin, ...data };
  })()`);
  const target = resolveOutPath(path);
  writeFileSync(target, JSON.stringify({ cookies, origins: [origins] }, null, 2));
  return { content: [{ type: "text", text: `Saved storage state: ${target} (${cookies.length} cookies, ${Object.keys((origins as any).local || {}).length} localStorage, ${Object.keys((origins as any).session || {}).length} sessionStorage)` }] };
});

regTool("storage_state_load", "Load cookies + localStorage from a JSON file (created by storage_state_save). Bypass CF/login if session is fresh.", {
  path: z.string().describe("Path to storage state JSON file"),
  navigate_to: z.string().optional().describe("URL to navigate to after loading (recommended — localStorage requires same-origin)"),
}, async ({ path, navigate_to }) => {
  const page = getPage();
  const ctx = page.context();
  const target = expandHome(path);
  let data: any;
  try {
    data = JSON.parse((await import("fs")).readFileSync(target, "utf8"));
  } catch (e: any) {
    return { content: [{ type: "text", text: `Failed to load storage state from ${target}: ${e?.message || e}` }], isError: true };
  }
  if (data.cookies && data.cookies.length) await ctx.addCookies(data.cookies);
  let lsCount = 0, ssCount = 0;
  if (navigate_to) {
    await page.goto(navigate_to, { waitUntil: "domcontentloaded" });
    const origin = data.origins?.[0] || {};
    if (origin.local || origin.session) {
      await page.evaluate(`((data) => {
        if (data.local) Object.entries(data.local).forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch {} });
        if (data.session) Object.entries(data.session).forEach(([k, v]) => { try { sessionStorage.setItem(k, v); } catch {} });
      })(${JSON.stringify(origin)})`);
      lsCount = Object.keys(origin.local || {}).length;
      ssCount = Object.keys(origin.session || {}).length;
    }
  }
  return { content: [{ type: "text", text: `Loaded storage state: ${data.cookies?.length || 0} cookies${navigate_to ? `, ${lsCount} localStorage, ${ssCount} sessionStorage (after navigate)` : " (call navigate to apply localStorage)"}` }] };
});

regTool("auth_capture", "Save current session as named auth state (e.g. logged-in user). Convenience wrapper: storage_state_save to ~/.camoufox-mcp/sessions/<name>.json", {
  name: z.string().describe("Session name (e.g. 'github-bob', 'shopify-mystore')"),
}, async ({ name }) => {
  const page = getPage();
  const ctx = page.context();
  const cookies = await ctx.cookies();
  const origins = await page.evaluate(`(() => {
    var data = { local: {}, session: {} };
    for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); data.local[k] = localStorage.getItem(k); }
    for (var j = 0; j < sessionStorage.length; j++) { var k = sessionStorage.key(j); data.session[k] = sessionStorage.getItem(k); }
    return { url: location.href, origin: location.origin, ...data };
  })()`);
  const target = resolveOutPath(`${PROFILE_PARENT}/sessions/${name}.json`);
  writeFileSync(target, JSON.stringify({ cookies, origins: [origins] }, null, 2));
  return { content: [{ type: "text", text: `auth_capture saved: ${target}` }] };
});

// ── Tools: Cookie Bulk ─────────────────────────────────────────────────────

regTool("cookie_export_file", "Export all cookies to a JSON file (Playwright format).", {
  path: z.string().describe("Output JSON file path"),
}, async ({ path }) => {
  const page = getPage();
  const cookies = await page.context().cookies();
  const target = resolveOutPath(path);
  writeFileSync(target, JSON.stringify(cookies, null, 2));
  return { content: [{ type: "text", text: `Exported ${cookies.length} cookies to ${target}` }] };
});

regTool("cookie_import_file", "Import cookies from a JSON file (Playwright format).", {
  path: z.string().describe("Input JSON file path"),
}, async ({ path }) => {
  const page = getPage();
  const target = expandHome(path);
  let cookies: any;
  try {
    cookies = JSON.parse((await import("fs")).readFileSync(target, "utf8"));
  } catch (e: any) {
    return { content: [{ type: "text", text: `Failed to import cookies from ${target}: ${e?.message || e}` }], isError: true };
  }
  if (!Array.isArray(cookies)) {
    return { content: [{ type: "text", text: `Invalid cookie file ${target}: expected a JSON array (Playwright format).` }], isError: true };
  }
  await page.context().addCookies(cookies);
  return { content: [{ type: "text", text: `Imported ${cookies.length} cookies from ${target}` }] };
});

// ── Tools: Humanize ────────────────────────────────────────────────────────

regTool("humanize_click", "Click element with humanized mouse approach (3-step Bezier-like curve before click). Use for anti-bot pages.", {
  ref: z.string().optional().describe("Element ref from snapshot"),
  selector: z.string().optional().describe("CSS selector"),
}, async ({ ref, selector }) => {
  const page = getPage();
  if (!ref && !selector) return { content: [{ type: "text", text: "Error: ref or selector required" }], isError: true };
  const loc = ref ? refLocator(page, ref) : page.locator(selector!).first();
  // Scroll into view first: boundingBox() is viewport-relative, so on a scrolled
  // page an off-screen element yields negative coords and the "click" lands nowhere.
  try { await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT }); } catch {}
  const box = await loc.boundingBox();
  if (!box) return { content: [{ type: "text", text: "Error: element has no bounding box" }], isError: true };
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  if (box.x + box.width < 0 || box.y + box.height < 0 || box.x > vp.width || box.y > vp.height) {
    return { content: [{ type: "text", text: `Error: element is outside the viewport (box x=${Math.round(box.x)} y=${Math.round(box.y)}), a real mouse click cannot reach it. Scroll it into view first.` }], isError: true };
  }
  const tx = box.x + box.width / 2 + (Math.random() * 8 - 4);
  const ty = box.y + box.height / 2 + (Math.random() * 6 - 3);
  await page.mouse.move(tx + 200, ty - 100, { steps: 20 });
  await page.waitForTimeout(180 + Math.random() * 120);
  await page.mouse.move(tx + 60, ty - 25, { steps: 12 });
  await page.waitForTimeout(120 + Math.random() * 80);
  await page.mouse.move(tx, ty, { steps: 8 });
  await page.waitForTimeout(70 + Math.random() * 50);
  await page.mouse.click(tx, ty);
  return { content: [{ type: "text", text: `humanize_click at (${Math.round(tx)},${Math.round(ty)})` }] };
});

regTool("humanize_type", "Type text with Gaussian-distributed delays between keystrokes (mean ~80ms, sigma ~30ms). Mimics human typing rhythm.", {
  ref: z.string().optional(),
  selector: z.string().optional(),
  text: z.string().describe("Text to type"),
  mean_delay_ms: z.number().default(80),
}, async ({ ref, selector, text, mean_delay_ms }) => {
  const page = getPage();
  if (ref) await refLocator(page, ref).focus();
  else if (selector) await page.locator(selector).first().focus();
  for (const ch of text) {
    await page.keyboard.type(ch);
    // Gaussian-ish delay (Box-Muller)
    const u1 = Math.max(0.0001, Math.random()), u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const delay = Math.max(20, mean_delay_ms + z * (mean_delay_ms * 0.4));
    await page.waitForTimeout(delay);
  }
  return { content: [{ type: "text", text: `humanize_type typed ${text.length} chars` }] };
});

regTool("mouse_drift", "Random mouse movements over a duration — builds up mouse history before action (CF/DataDome behavior analysis).", {
  duration_ms: z.number().default(2000).describe("Total drift duration"),
  points: z.number().default(5).describe("Number of random destinations"),
}, async ({ duration_ms, points }) => {
  const page = getPage();
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const interval = duration_ms / points;
  for (let i = 0; i < points; i++) {
    const x = Math.floor(Math.random() * (vp.width - 100)) + 50;
    const y = Math.floor(Math.random() * (vp.height - 100)) + 50;
    await page.mouse.move(x, y, { steps: 12 });
    await page.waitForTimeout(interval * (0.7 + Math.random() * 0.6));
  }
  return { content: [{ type: "text", text: `mouse_drift: ${points} points over ${duration_ms}ms` }] };
});

regTool("mouse_record", "Start recording mouse positions (call mouse_replay later). Returns recorder handle.", {
  duration_ms: z.number().default(5000),
  sample_rate_hz: z.number().default(30),
}, async ({ duration_ms, sample_rate_hz }) => {
  const page = getPage();
  const handle = `rec-${Date.now()}`;
  await page.evaluate(`(() => {
    window.__mcp_mouse_rec = { points: [], start: Date.now() };
    var h = (e) => window.__mcp_mouse_rec.points.push({ x: e.clientX, y: e.clientY, t: Date.now() - window.__mcp_mouse_rec.start });
    window.__mcp_mouse_rec_handler = h;
    document.addEventListener('mousemove', h, { passive: true });
    setTimeout(() => document.removeEventListener('mousemove', window.__mcp_mouse_rec_handler), ${duration_ms});
  })()`);
  return { content: [{ type: "text", text: `mouse_record started: ${handle} (${duration_ms}ms, ~${sample_rate_hz}Hz). Move mouse manually then call mouse_replay.` }] };
});

regTool("mouse_replay", "Replay last recorded mouse path with original timing.", {
  speed: z.number().default(1.0).describe("Replay speed multiplier (1.0=original, 2.0=2x faster)"),
}, async ({ speed }) => {
  const page = getPage();
  const points = await page.evaluate(`(window.__mcp_mouse_rec?.points || [])`) as any[];
  if (!points.length) return { content: [{ type: "text", text: "No recording found — call mouse_record first" }] };
  let lastT = 0;
  for (const p of points) {
    const wait = (p.t - lastT) / speed;
    if (wait > 5) await page.waitForTimeout(wait);
    await page.mouse.move(p.x, p.y);
    lastT = p.t;
  }
  return { content: [{ type: "text", text: `mouse_replay: ${points.length} points` }] };
});

// ── Tools: Session Warmup & Anti-Bot Detection ─────────────────────────────

regTool("session_warmup", "Visit innocuous public sites (Google, Wikipedia) to build browsing history before targeting protected site. Helps with CF/DataDome IP scoring.", {
  duration_ms: z.number().default(10000).describe("Total warmup time"),
  sites: z.array(z.string()).optional().describe("URLs to visit (default: google.com, wikipedia.org)"),
}, async ({ duration_ms, sites }) => {
  const page = getPage();
  const urls = sites && sites.length ? sites : [
    "https://www.google.com", "https://en.wikipedia.org/wiki/Special:Random",
  ];
  const per = Math.floor(duration_ms / urls.length);
  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(per * 0.4);
      // Random scroll — via window.scrollBy, since mouse.wheel is a no-op in Camoufox
      const dy = Math.round(200 + Math.random() * 400);
      await page.evaluate(`window.scrollBy(0, ${dy})`).catch(() => {});
      await page.waitForTimeout(per * 0.3);
    } catch {}
  }
  return { content: [{ type: "text", text: `session_warmup: visited ${urls.length} sites over ${duration_ms}ms` }] };
});

regTool("detect_anti_bot", "Heuristic detection of anti-bot vendor on current page (Cloudflare, DataDome, Akamai, PerimeterX, Imperva).", {}, async () => {
  const page = getPage();
  const result = await page.evaluate(`(() => {
    var html = document.documentElement.outerHTML.slice(0, 50000);
    var hits = [];
    if (/challenges\\.cloudflare|__cf_chl|cf-turnstile|turnstile/i.test(html) || /cloudflare/i.test(document.title)) hits.push("Cloudflare");
    if (/datadome|dd-captcha|js\\.datadome\\.co/i.test(html)) hits.push("DataDome");
    if (/akamai|akam\\.net|_bm\\.|bot-detector\\.akamai/i.test(html)) hits.push("Akamai");
    if (/perimeterx|px-captcha|_pxhd/i.test(html)) hits.push("PerimeterX");
    if (/imperva|incapsula/i.test(html)) hits.push("Imperva");
    if (/recaptcha|g-recaptcha|grecaptcha/i.test(html)) hits.push("reCAPTCHA");
    if (/hcaptcha/i.test(html)) hits.push("hCaptcha");
    return { vendors: hits, title: document.title, url: location.href };
  })()`) as any;
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

// ── Tools: Assertions ──────────────────────────────────────────────────────

regTool("assert_element_visible", "Assert element exists and is visible. Returns success/fail (no throw).", {
  selector: z.string(),
}, async ({ selector }) => {
  const page = getPage();
  try {
    const el = page.locator(selector).first();
    const visible = await el.isVisible({ timeout: 3000 });
    return { content: [{ type: "text", text: visible ? `PASS: ${selector} visible` : `FAIL: ${selector} not visible` }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: `FAIL: ${selector} not found (${e.message?.slice(0, 80)})` }] };
  }
});

regTool("assert_text_present", "Assert text is present anywhere on page (case-sensitive substring).", {
  text: z.string(),
}, async ({ text }) => {
  const page = getPage();
  // Do the substring test in-page so we ship back a boolean, not the entire
  // document text (which can be megabytes on large pages).
  const found = await page.evaluate(
    `document.body.innerText.includes(${JSON.stringify(text)})`
  ) as boolean;
  return { content: [{ type: "text", text: found ? `PASS: '${text}' present` : `FAIL: '${text}' not found in body` }] };
});

regTool("assert_url_matches", "Assert current URL matches pattern (substring or regex).", {
  pattern: z.string(),
  regex: z.boolean().default(false),
}, async ({ pattern, regex }) => {
  const page = getPage();
  const url = page.url();
  const match = regex ? new RegExp(pattern).test(url) : url.includes(pattern);
  return { content: [{ type: "text", text: match ? `PASS: URL '${url}' matches '${pattern}'` : `FAIL: URL '${url}' does not match '${pattern}'` }] };
});

// ── Tools: Convenience / Workflow ──────────────────────────────────────────

regTool("click_and_wait", "Click element then wait for navigation or selector. Atomic — fewer roundtrips than separate click + wait_for.", {
  ref: z.string().optional(),
  selector: z.string().optional(),
  wait_for_url: z.string().optional().describe("URL substring to wait for after click"),
  wait_for_selector: z.string().optional().describe("Selector to wait for after click"),
  timeout_ms: z.number().default(15000),
}, async ({ ref, selector, wait_for_url, wait_for_selector, timeout_ms }) => {
  const page = getPage();
  if (!ref && !selector) return { content: [{ type: "text", text: "Error: ref or selector required" }], isError: true };
  const loc = ref ? refLocator(page, ref) : page.locator(selector!).first();
  const beforeUrl = page.url();
  await Promise.all([
    loc.click({ timeout: timeout_ms }),
    wait_for_url ? page.waitForURL((u) => u.toString().includes(wait_for_url), { timeout: timeout_ms }).catch(() => {}) :
    wait_for_selector ? page.waitForSelector(wait_for_selector, { timeout: timeout_ms }).catch(() => {}) :
    page.waitForLoadState("domcontentloaded", { timeout: timeout_ms }).catch(() => {}),
  ]);
  return { content: [{ type: "text", text: `click_and_wait: ${beforeUrl} → ${page.url()}` }] };
});

regTool("wait_for_network_idle", "Wait until there are no in-flight requests for idle_ms continuously. Better than fixed timeouts for SPAs.", {
  idle_ms: z.number().default(500).describe("How long the network must stay quiet before returning."),
  timeout_ms: z.number().default(30000),
}, async ({ idle_ms, timeout_ms }) => {
  const page = getPage();
  // Track in-flight requests ourselves instead of waitForLoadState("networkidle"),
  // whose 500ms threshold is fixed — this actually honours idle_ms.
  let inflight = 0;
  const onRequest = () => { inflight++; };
  const onSettled = () => { if (inflight > 0) inflight--; };
  page.on("request", onRequest);
  page.on("requestfinished", onSettled);
  page.on("requestfailed", onSettled);
  const started = Date.now();
  try {
    const deadline = started + timeout_ms;
    let quietSince = inflight === 0 ? started : 0;
    while (Date.now() < deadline) {
      if (inflight === 0) {
        if (!quietSince) quietSince = Date.now();
        if (Date.now() - quietSince >= idle_ms) {
          return { content: [{ type: "text", text: `network idle for ${idle_ms}ms (waited ${Date.now() - started}ms)` }] };
        }
      } else {
        quietSince = 0;
      }
      await page.waitForTimeout(100);
    }
    return { content: [{ type: "text", text: `timeout after ${timeout_ms}ms — still ${inflight} request(s) in flight (never idle for ${idle_ms}ms).` }] };
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onSettled);
    page.off("requestfailed", onSettled);
  }
});

regTool(
  "describe_page",
  "Compact LLM-friendly page summary (title, heading, key buttons, forms). Cheaper than browser_snapshot for agent context. " +
    "Also returns `intent` — a classified hint of what kind of page this is " +
    "(login_email, login_password, otp_input, captcha, stay_signed_in, protect_account, error_page, " +
    "consent, two_factor, account_disabled, content, unknown) — so the agent can branch with one read.",
  {},
  async () => {
    const page = getPage();
    const summary: any = await page.evaluate(`(() => {
    var title = document.title;
    var url = location.href;
    var h1 = document.querySelector('h1')?.innerText?.slice(0,100) || '';
    var h2s = Array.from(document.querySelectorAll('h2')).slice(0,5).map(h => h.innerText.slice(0,60));
    var buttons = Array.from(document.querySelectorAll('button, [role=button], input[type=submit]')).slice(0,10)
      .map(b => (b.innerText || b.value || '').trim().slice(0,40)).filter(t => t);
    var links = Array.from(document.querySelectorAll('a[href]')).slice(0,8)
      .map(a => ({ text: a.innerText.trim().slice(0,40), href: a.href.slice(0,80) })).filter(l => l.text);
    var forms = Array.from(document.querySelectorAll('form')).map(f => ({
      action: f.action?.slice(0,60),
      fields: Array.from(f.querySelectorAll('input, textarea, select')).slice(0,8).map(i => i.name || i.id || i.type),
    }));
    var body = (document.body?.innerText || '').slice(0, 1500);
    var inputs = Array.from(document.querySelectorAll('input')).map(i => ({
      type: i.type, name: i.name || '', id: i.id || '',
      placeholder: i.placeholder || '', autocomplete: i.autocomplete || '',
    }));
    return { title, url, h1, h2s, buttons, links, forms, _body_sample: body, _inputs: inputs };
  })()`);

    // ── Intent classification (server-side hint) ─────────────────────────────
    const body = String(summary._body_sample || "");
    const title = String(summary.title || "");
    const h1 = String(summary.h1 || "");
    const url = String(summary.url || "");
    const inputs: Array<{type:string;name:string;id:string;placeholder:string;autocomplete:string}> = summary._inputs || [];
    const buttons: string[] = summary.buttons || [];
    const all = (title + " | " + h1 + " | " + body).toLowerCase();
    const btnText = buttons.join(" | ").toLowerCase();

    const hasInput = (pred: (i: any) => boolean) => inputs.some(pred);

    let intent: string = "unknown";
    // Error / disabled — check first since they may have form-like structure
    if (/account_deactivated|account is disabled|account suspended|account has been disabled/i.test(all)) {
      intent = "account_disabled";
    } else if (/oops, an error occurred|something went wrong|error_code:/i.test(all) && /try again/i.test(btnText + " " + all)) {
      intent = "error_page";
    } else if (/captcha|i'm not a robot|verify you are human|cloudflare|turnstile|hcaptcha|recaptcha/i.test(all)) {
      intent = "captcha";
    } else if (/stay signed in|keep me signed in|skip having to sign in/i.test(all)) {
      intent = "stay_signed_in";
    } else if (/let's protect your account|protect your account|skip for now|add security info/i.test(all)) {
      intent = "protect_account";
    } else if (/check your phone|enter the verification code we just sent|two-factor|2fa|authenticator/i.test(all)) {
      intent = "two_factor";
    } else if (/verification code|enter the code|one-time code|otp|temporary verification/i.test(all)
               && (hasInput(i => /otp|code|verification/i.test(i.name + i.id + i.placeholder + i.autocomplete))
                   || hasInput(i => i.type === "text" || i.type === "tel" || i.type === "number"))) {
      intent = "otp_input";
    } else if (hasInput(i => i.type === "password" || /password|passwd/i.test(i.name + i.id + i.autocomplete))) {
      intent = "login_password";
    } else if (hasInput(i => i.type === "email" || /email|username|login|loginfmt/i.test(i.name + i.id + i.placeholder + i.autocomplete))) {
      intent = "login_email";
    } else if (/authorize|allow access|grant.*access|consent/i.test(all) && /authorize|allow|continue/i.test(btnText)) {
      intent = "consent";
    } else if (inputs.length === 0 && buttons.length === 0 && body.length > 200) {
      intent = "content";
    }

    summary.intent = intent;
    // Strip internal helpers to keep response small
    delete summary._body_sample;
    delete summary._inputs;
    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// Browserless HTTP kit — TLS-impersonating fetch via impit
//
// The browser is the expensive path: a Camoufox launch costs seconds and ~400MB.
// Most fetches don't need a DOM at all. impit ships with camoufox-js and speaks
// a real Firefox TLS/HTTP2 fingerprint (JA4 t13d1715h2…), so the browserless
// path is as "real" as the browser one — and here it matches the browser we
// actually drive, instead of pretending to be Chrome.
// ═══════════════════════════════════════════════════════════════════════════

type Impersonate = "firefox" | "chrome";

// impit is a native module; load it lazily so a platform without prebuilt
// bindings still gets a working server (only these tools degrade).
let impitMod: any = null;
async function getImpit(impersonate: Impersonate, proxy?: string, timeoutMs = 30000): Promise<any> {
  if (!impitMod) {
    try { impitMod = await import("impit"); }
    catch (e: any) {
      throw new Error(`impit (native HTTP client) unavailable on this platform: ${e?.message || e}. Use the browser tools instead (navigate + scrape_page).`);
    }
  }
  const opts: any = { browser: impersonate, timeout: timeoutMs, followRedirects: true };
  if (proxy) opts.proxyUrl = proxy;
  return new impitMod.Impit(opts);
}

// Cookies the live browser session would send for this URL — lets an HTTP call
// ride a session established by a real login.
async function cookieHeaderFor(url: string): Promise<string> {
  if (!browserContext) return "";
  try {
    const cookies = await browserContext.cookies(url);
    return cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
  } catch { return ""; }
}

const BLOCK_STATUS = new Set([401, 403, 405, 406, 409, 421, 429, 503]);
const BLOCK_MARKERS = [
  "just a moment", "cf-chl", "challenge-platform", "checking your browser",
  "attention required", "captcha-delivery", "please verify you are a human",
  "access denied", "enable javascript and cookies to continue",
  "verifying you are human", "px-captcha", "incapsula incident",
];

// Does this response smell like an anti-bot wall (→ worth spending a browser on)?
function looksBlocked(status: number | null, text: string): boolean {
  if (status === null) return true;
  if (BLOCK_STATUS.has(status)) return true;
  const low = (text || "").slice(0, 6000).toLowerCase();
  if (BLOCK_MARKERS.some(m => low.includes(m))) return true;
  // A 200 with an almost-empty body is usually a JS-challenge shell.
  if (status === 200 && (text || "").length < 512 && (low.includes("<html") || low.trim() === "")) return true;
  return false;
}

async function impitFetch(opts: {
  url: string; method?: string; headers?: Record<string, string>; body?: string;
  impersonate?: Impersonate; proxy?: string; timeoutMs?: number; useBrowserCookies?: boolean;
}): Promise<{ status: number | null; text: string; headers: Record<string, string>; url: string; error?: string }> {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.useBrowserCookies !== false) {
    const ck = await cookieHeaderFor(opts.url);
    if (ck && !Object.keys(headers).some(k => k.toLowerCase() === "cookie")) headers["Cookie"] = ck;
  }
  try {
    const client = await getImpit(opts.impersonate || "firefox", opts.proxy, opts.timeoutMs || 30000);
    const res = await client.fetch(opts.url, {
      method: (opts.method || "GET").toUpperCase(),
      headers,
      ...(opts.body ? { body: opts.body } : {}),
    });
    const text = await res.text().catch(() => "");
    const hdrs: Record<string, string> = {};
    try { for (const [k, v] of (res.headers as any).entries()) hdrs[k] = String(v); } catch {}
    return { status: res.status, text, headers: hdrs, url: res.url || opts.url };
  } catch (e: any) {
    return { status: null, text: "", headers: {}, url: opts.url, error: String(e?.message || e) };
  }
}

// ── HTML → markdown (no DOM, no dependency) ────────────────────────────────

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
    hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", middot: "·", bull: "•",
    copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", deg: "°", euro: "€", pound: "£",
  };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return Number.isFinite(code) ? String.fromCodePoint(code) : m; } catch { return m; }
    }
    return named[e.toLowerCase()] ?? m;
  });
}

// Prefer the primary content container so nav/sidebar/footer noise never
// reaches the model.
function sliceMain(html: string): string {
  const m = html.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);
  if (m && m[2].length > 400) return m[2];
  const d = html.match(/<div[^>]+(?:id|class)=["'][^"']*(?:content|main|article|post|entry)[^"']*["'][^>]*>([\s\S]*)/i);
  if (d && d[1].length > 800) return d[1];
  const b = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return b ? b[1] : html;
}

function htmlToMarkdown(html: string, baseUrl = "", maxChars = 20000): string {
  if (!html) return "";
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = tm ? decodeEntities(tm[1].replace(/<[^>]+>/g, "")).trim() : "";
  let s = sliceMain(html);
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg|template|iframe|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, t) => `\n\n\`\`\`\n${decodeEntities(t.replace(/<[^>]+>/g, "")).trim()}\n\`\`\`\n\n`);
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, l, t) => `\n\n${"#".repeat(Number(l))} ${t.replace(/<[^>]+>/g, " ").trim()}\n\n`);
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `\n- ${t.replace(/<[^>]+>/g, " ").trim()}`);
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs, t) => {
    const text = t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!text) return " ";
    const h = String(attrs).match(/href=["']([^"']+)["']/i);
    if (!h) return text;
    let abs = h[1];
    try { abs = new URL(h[1], baseUrl || undefined).toString(); } catch {}
    return abs.startsWith("http") ? `[${text}](${abs})` : text;
  });
  s = s.replace(/<img\b[^>]*alt=["']([^"']+)["'][^>]*>/gi, (_m, a) => `![${a}] `);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, t) => `\`${t.replace(/<[^>]+>/g, "").trim()}\``);
  s = s.replace(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi, (_m, t) => ` ${t.replace(/<[^>]+>/g, " ").trim()} |`);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|section|tr|ul|ol|table|blockquote|h[1-6])>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  const lines = s.split("\n").map(l => l.replace(/[ \t ]+/g, " ").trim());
  let text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (title && !text.startsWith("#")) text = `# ${title}\n\n${text}`;
  if (text.length > maxChars) text = text.slice(0, maxChars).trimEnd() + `\n\n[truncated at ${maxChars} chars]`;
  return text;
}

// ── SERP parsing ───────────────────────────────────────────────────────────

interface SerpHit { title: string; url: string; snippet: string }

function htmlAnchors(html: string): { attrs: string; href: string; text: string }[] {
  const out: { attrs: string; href: string; text: string }[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const h = m[1].match(/href=["']([^"']+)["']/i);
    out.push({
      attrs: m[1], href: h ? decodeEntities(h[1]) : "",
      text: decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

// DuckDuckGo wraps results in /l/?uddg=<encoded>. Unwrap to the real URL.
function decodeDdgHref(href: string): string {
  let h = href;
  if (h.startsWith("//")) h = "https:" + h;
  if (h.includes("uddg=")) {
    try {
      const u = new URL(h, "https://duckduckgo.com");
      const real = u.searchParams.get("uddg");
      if (real) return real;
    } catch {}
  }
  return h;
}

function parseDDG(html: string): SerpHit[] {
  const hits: SerpHit[] = [];
  for (const a of htmlAnchors(html)) {
    if (!/result__a|result-link/.test(a.attrs)) continue;
    const url = decodeDdgHref(a.href);
    if (!url.startsWith("http") || !a.text) continue;
    if (/duckduckgo\.com/.test(url)) continue;
    hits.push({ title: a.text, url, snippet: "" });
  }
  const sre = /class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|td|div)>/gi;
  let i = 0, sm: RegExpExecArray | null;
  while ((sm = sre.exec(html)) && i < hits.length) {
    hits[i++].snippet = decodeEntities(sm[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 280);
  }
  return hits;
}

// Bing wraps every result in a tracking redirect: /ck/a?…&u=a1<base64url>.
// Left undecoded, a "result URL" is a bing.com redirect — deep_research would
// fetch Bing instead of the source.
function decodeBingHref(href: string): string {
  if (!/bing\.com\/ck\/a/i.test(href)) return href;
  try {
    const enc = new URL(href, "https://www.bing.com").searchParams.get("u") || "";
    if (enc.startsWith("a1")) {
      const b64 = enc.slice(2).replace(/-/g, "+").replace(/_/g, "/");
      const dec = Buffer.from(b64 + "=".repeat((4 - b64.length % 4) % 4), "base64").toString("utf8");
      if (/^https?:\/\//i.test(dec)) return dec;
    }
  } catch {}
  return href;
}

function parseBing(html: string): SerpHit[] {
  const hits: SerpHit[] = [];
  const seen = new Set<string>();
  const blocks = html.split(/<li[^>]+class=["'][^"']*b_algo/i).slice(1);
  for (const b of blocks) {
    // The <h2> anchor is the real result title; the first anchor in the block is
    // often the breadcrumb/citation line ("example.com › docs").
    const h2 = b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const a = (h2 ? htmlAnchors(h2[1]).find(x => x.href && x.text) : null)
      || htmlAnchors(b).find(x => x.href && x.text);
    if (!a) continue;
    const url = decodeBingHref(a.href);
    if (!/^https?:\/\//i.test(url)) continue;
    if (/^https?:\/\/(www\.)?bing\.com/i.test(url)) continue;   // redirect we couldn't decode
    if (seen.has(url)) continue;
    seen.add(url);
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    hits.push({
      title: a.text, url,
      snippet: p ? decodeEntities(p[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 280) : "",
    });
  }
  return hits;
}

// Rapid-fire SERP hits get soft-blocked (degraded/decoy results). Keep a gap.
let lastSerpAt = 0;
async function serpThrottle(): Promise<void> {
  const gap = 1000 - (Date.now() - lastSerpAt);
  if (gap > 0) await new Promise(r => setTimeout(r, gap));
  lastSerpAt = Date.now();
}

async function runSearch(query: string, engine: string, count: number, proxy?: string): Promise<{ hits: SerpHit[]; via: string }> {
  const q = encodeURIComponent(query);
  const attempts: { via: string; run: () => Promise<SerpHit[]> }[] = [];
  const ddgHtml = async () => {
    const r = await impitFetch({
      url: "https://html.duckduckgo.com/html/", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: "https://html.duckduckgo.com/" },
      body: `q=${q}&kl=us-en`, proxy, useBrowserCookies: false,
    });
    return r.status === 200 ? parseDDG(r.text) : [];
  };
  const ddgLite = async () => {
    const r = await impitFetch({ url: `https://lite.duckduckgo.com/lite/?q=${q}`, proxy, useBrowserCookies: false });
    return r.status === 200 ? parseDDG(r.text) : [];
  };
  const bing = async () => {
    const r = await impitFetch({ url: `https://www.bing.com/search?q=${q}&setmkt=en-US`, proxy, useBrowserCookies: false });
    return r.status === 200 ? parseBing(r.text) : [];
  };
  if (engine === "bing") attempts.push({ via: "bing", run: bing }, { via: "duckduckgo-html", run: ddgHtml }, { via: "duckduckgo-lite", run: ddgLite });
  else attempts.push({ via: "duckduckgo-html", run: ddgHtml }, { via: "duckduckgo-lite", run: ddgLite }, { via: "bing", run: bing });
  for (const a of attempts) {
    await serpThrottle();
    let hits: SerpHit[] = [];
    try { hits = await a.run(); } catch {}
    if (hits.length) return { hits: hits.slice(0, count), via: a.via };
  }
  return { hits: [], via: "none" };
}

regTool("http_request",
  "HTTP request WITHOUT a browser, using a real Firefox TLS/HTTP2 fingerprint (impit). " +
  "By default it reuses the live browser's cookies for that URL, so you can log in with the browser and then hit the site's API cheaply. " +
  "Far faster and lighter than navigating — use it for APIs, JSON, and any page that doesn't need JS.",
  {
    url: z.string(),
    method: z.string().default("GET"),
    body: z.string().default("").describe("Raw request body (JSON string, form-encoded, …)"),
    headers_json: z.string().default("").describe('Extra headers as JSON, e.g. {"Accept":"application/json"}'),
    impersonate: z.enum(["firefox", "chrome"]).default("firefox").describe("TLS fingerprint to present. firefox matches the Camoufox browser."),
    use_browser_cookies: z.boolean().default(true),
    proxy: z.string().default("").describe("Proxy URL, e.g. http://user:pass@host:port"),
    timeout_ms: z.number().default(30000),
    max_chars: z.number().default(20000).describe("Max response body characters returned."),
  },
  async ({ url, method, body, headers_json, impersonate, use_browser_cookies, proxy, timeout_ms, max_chars }) => {
    let headers: Record<string, string> = {};
    if (headers_json) {
      try { headers = JSON.parse(headers_json); }
      catch (e: any) { return { content: [{ type: "text", text: `Invalid headers_json: ${e?.message || e}` }], isError: true }; }
    }
    const r = await impitFetch({ url, method, headers, body: body || undefined, impersonate, proxy: proxy || undefined, timeoutMs: timeout_ms, useBrowserCookies: use_browser_cookies });
    if (r.error) return { content: [{ type: "text", text: `Request failed: ${r.error}` }], isError: true };
    const blocked = looksBlocked(r.status, r.text);
    const shown = r.text.length > max_chars ? r.text.slice(0, max_chars) + `\n…[truncated, ${r.text.length} chars total]` : r.text;
    const hdrLines = Object.entries(r.headers).slice(0, 15).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    return {
      content: [{ type: "text", text:
        `${method.toUpperCase()} ${r.url}\nstatus: ${r.status}${blocked ? "  ⚠ looks anti-bot blocked — retry via the browser (smart_fetch escalates automatically)" : ""}\n` +
        `cookies sent: ${use_browser_cookies ? "browser session" : "none"}  impersonate: ${impersonate}\n\n── headers ──\n${hdrLines}\n\n── body ──\n${shown}` }],
    };
  });

regTool("http_session_cookies",
  "Show which browser cookies would be sent with an HTTP request to this URL. Use it to confirm session sharing before relying on http_request.",
  { url: z.string() },
  async ({ url }) => {
    if (!browserContext) throw new Error("Browser not running. Call browser_launch first.");
    const cookies = await browserContext.cookies(url);
    if (!cookies.length) return { content: [{ type: "text", text: `No cookies would be sent to ${url}.` }] };
    const lines = cookies.map((c: any) =>
      `  ${c.name}=${String(c.value).slice(0, 30)}…  domain=${c.domain} path=${c.path}${c.httpOnly ? " httpOnly" : ""}${c.secure ? " secure" : ""}${(!c.expires || c.expires <= 0) ? " [session]" : ""}`);
    return { content: [{ type: "text", text: `${cookies.length} cookie(s) for ${url}:\n${lines.join("\n")}` }] };
  });

regTool("scrape_markdown",
  "Fetch a URL and return clean, LLM-ready markdown (headings, links, lists preserved; nav/footer/scripts stripped). " +
  "Default path is browserless (impit) — fast and cheap. Set use_browser=true for JS-rendered pages (needs browser_launch).",
  {
    url: z.string(),
    use_browser: z.boolean().default(false).describe("Render in the stealth browser instead of a plain HTTP fetch."),
    impersonate: z.enum(["firefox", "chrome"]).default("firefox"),
    max_chars: z.number().default(20000),
    proxy: z.string().default(""),
  },
  async ({ url, use_browser, impersonate, max_chars, proxy }) => {
    if (use_browser) {
      const page = getPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(1200);
      const html = await page.content();
      return { content: [{ type: "text", text: `source: browser\nurl: ${page.url()}\n\n${htmlToMarkdown(html, page.url(), max_chars)}` }] };
    }
    const r = await impitFetch({ url, impersonate, proxy: proxy || undefined });
    if (r.error) return { content: [{ type: "text", text: `Fetch failed: ${r.error}` }], isError: true };
    if (looksBlocked(r.status, r.text)) {
      return { content: [{ type: "text", text: `Blocked by anti-bot (status ${r.status}) at ${r.url}. Retry with use_browser=true, or call smart_fetch which escalates automatically.` }], isError: true };
    }
    return { content: [{ type: "text", text: `source: http (${impersonate} TLS)\nstatus: ${r.status}\nurl: ${r.url}\n\n${htmlToMarkdown(r.text, r.url, max_chars)}` }] };
  });

regTool("smart_fetch",
  "Dual-mode fetch: tries the browserless HTTP path first and escalates to the stealth browser ONLY when the response looks anti-bot blocked. " +
  "This is the efficiency core — high-volume reading stays cheap, the browser fires only when it's actually needed.",
  {
    url: z.string(),
    force_browser: z.boolean().default(false),
    impersonate: z.enum(["firefox", "chrome"]).default("firefox"),
    max_chars: z.number().default(20000),
    proxy: z.string().default(""),
  },
  async ({ url, force_browser, impersonate, max_chars, proxy }) => {
    let httpNote = "";
    if (!force_browser) {
      const r = await impitFetch({ url, impersonate, proxy: proxy || undefined });
      if (!r.error && !looksBlocked(r.status, r.text)) {
        return { content: [{ type: "text", text: `path: http (no browser used)\nstatus: ${r.status}\nurl: ${r.url}\n\n${htmlToMarkdown(r.text, r.url, max_chars)}` }] };
      }
      httpNote = r.error ? `http error: ${r.error}` : `http status ${r.status} looked blocked`;
    }
    if (!browserUp || pages.length === 0) {
      return { content: [{ type: "text", text: `${httpNote || "browser forced"} — and no browser is running. Call browser_launch first, then retry.` }], isError: true };
    }
    const page = getPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    // Give a JS challenge time to clear itself before reading the DOM.
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1000);
      const html = await page.content();
      if (html.length > 1500 && !looksBlocked(200, html)) {
        return { content: [{ type: "text", text: `path: browser (escalated — ${httpNote})\nurl: ${page.url()}\n\n${htmlToMarkdown(html, page.url(), max_chars)}` }] };
      }
    }
    const html = await page.content();
    return { content: [{ type: "text", text: `path: browser (escalated — ${httpNote}); challenge may still be active\nurl: ${page.url()}\n\n${htmlToMarkdown(html, page.url(), max_chars)}` }] };
  });

regTool("web_search",
  "Web search with NO browser and NO API key — scrapes DuckDuckGo/Bing SERPs over the impersonated HTTP path. " +
  "Returns title + url + snippet per result. Pair with scrape_markdown or deep_research to actually read the hits.",
  {
    query: z.string(),
    engine: z.enum(["bing", "duckduckgo"]).default("bing").describe("bing is the default because some ISPs block DuckDuckGo outright; the other engine is still tried as a fallback."),
    count: z.number().default(8),
    proxy: z.string().default(""),
  },
  async ({ query, engine, count, proxy }) => {
    const { hits, via } = await runSearch(query, engine, count, proxy || undefined);
    if (!hits.length) {
      return { content: [{ type: "text", text: `No results for "${query}" (tried ${engine} + fallbacks). SERP markup may have changed, or the query was soft-blocked — retry in a few seconds or use a proxy.` }], isError: true };
    }
    const lines = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`);
    return { content: [{ type: "text", text: `${hits.length} result(s) for "${query}" via ${via}:\n\n${lines.join("\n\n")}` }] };
  });

regTool("deep_research",
  "One call: search → fetch the top N results → return clean markdown per source with citations. Fully browserless; " +
  "sources that are anti-bot blocked are flagged so you can re-fetch those few with smart_fetch(force_browser=true).",
  {
    query: z.string(),
    max_sources: z.number().default(4),
    engine: z.enum(["bing", "duckduckgo"]).default("bing"),
    per_source_chars: z.number().default(3000),
    proxy: z.string().default(""),
  },
  async ({ query, max_sources, engine, per_source_chars, proxy }) => {
    const { hits, via } = await runSearch(query, engine, max_sources, proxy || undefined);
    if (!hits.length) return { content: [{ type: "text", text: `No search results for "${query}".` }], isError: true };
    const parts: string[] = [`# Research: ${query}`, `_${hits.length} source(s) via ${via}_`, ""];
    let blocked = 0;
    // Fetch sources concurrently — they're independent and this is the slow bit.
    const fetched = await Promise.all(hits.map(h =>
      impitFetch({ url: h.url, impersonate: "firefox", proxy: proxy || undefined, useBrowserCookies: false })
        .then(r => ({ h, r })).catch(() => ({ h, r: { status: null, text: "", headers: {}, url: h.url, error: "fetch failed" } as any }))));
    for (let i = 0; i < fetched.length; i++) {
      const { h, r } = fetched[i];
      parts.push(`## [${i + 1}] ${h.title}`, h.url, "");
      if (r.error || looksBlocked(r.status, r.text)) {
        blocked++;
        parts.push(`_(blocked or unreachable — status ${r.status}${r.error ? `, ${r.error}` : ""}. Re-fetch with smart_fetch(force_browser=true).)_`, "");
        if (h.snippet) parts.push(`Snippet from SERP: ${h.snippet}`, "");
        continue;
      }
      parts.push(htmlToMarkdown(r.text, r.url, per_source_chars), "");
    }
    parts.push("---", `Sources: ${hits.map((h, i) => `[${i + 1}] ${h.url}`).join("  ")}`);
    if (blocked) parts.push(`${blocked} of ${hits.length} source(s) were blocked on the HTTP path.`);
    return { content: [{ type: "text", text: parts.join("\n") }] };
  });

// ═══════════════════════════════════════════════════════════════════════════
// LLM-ergonomics kit — fewer round-trips, fewer blind guesses
// ═══════════════════════════════════════════════════════════════════════════

// ref OR css selector → locator (the pattern half these tools need).
function targetLocator(page: Page, ref?: string, selector?: string): any | null {
  if (ref) return refLocator(page, ref);
  if (selector) return page.locator(selector).first();
  return null;
}

regTool("search_page",
  "Grep the CURRENT page's visible text and return matches with surrounding context. " +
  "Costs nothing compared to a snapshot or a screenshot — use it first to find where a term actually appears.",
  {
    text: z.string().describe("Substring, or a regex source when regex=true"),
    regex: z.boolean().default(false),
    max_matches: z.number().default(20),
    context_chars: z.number().default(120),
    case_sensitive: z.boolean().default(false),
  },
  async ({ text, regex, max_matches, context_chars, case_sensitive }) => {
    const page = getPage();
    const res = await page.evaluate(`(() => {
      var body = document.body ? (document.body.innerText || "") : "";
      var needle = ${jsStr(text)};
      var flags = "g" + (${case_sensitive} ? "" : "i");
      var re;
      try { re = ${regex} ? new RegExp(needle, flags) : new RegExp(needle.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&"), flags); }
      catch (e) { return { error: String(e && e.message || e) }; }
      var out = [], m, guard = 0;
      while ((m = re.exec(body)) !== null && out.length < ${max_matches} && guard++ < 5000) {
        if (m.index === re.lastIndex) re.lastIndex++;
        var s = Math.max(0, m.index - ${context_chars});
        var e2 = Math.min(body.length, m.index + m[0].length + ${context_chars});
        out.push({ at: m.index, match: m[0].slice(0, 120), context: body.slice(s, e2).replace(/\\s+/g, " ").trim() });
      }
      return { total_text: body.length, matches: out };
    })()`) as any;
    if (res?.error) return { content: [{ type: "text", text: `Invalid pattern: ${res.error}` }], isError: true };
    const ms = res?.matches || [];
    if (!ms.length) return { content: [{ type: "text", text: `"${text}" not found in the page's visible text (${res?.total_text || 0} chars).` }] };
    const lines = ms.map((m: any, i: number) => `${i + 1}. …${m.context}…`);
    return { content: [{ type: "text", text: `${ms.length} match(es) for "${text}":\n${lines.join("\n")}` }] };
  });

regTool("wait_for_change",
  "Wait until the page actually CHANGES and report what changed (url / title / DOM size / text). " +
  "This is the honest version of a fixed sleep after a click: it returns as soon as something happened, or tells you nothing did.",
  {
    timeout: z.number().default(10000),
    settle_ms: z.number().default(400).describe("Require the page to stay stable this long after the change."),
    poll_ms: z.number().default(200),
  },
  async ({ timeout, settle_ms, poll_ms }) => {
    const page = getPage();
    const SIG = `(() => ({ url: location.href, title: document.title, els: document.querySelectorAll("*").length, len: (document.body ? (document.body.innerText||"").length : 0) }))()`;
    const before: any = await page.evaluate(SIG);
    const deadline = Date.now() + timeout;
    let changedAt = 0, last: any = before;
    while (Date.now() < deadline) {
      await page.waitForTimeout(poll_ms);
      let now: any;
      try { now = await page.evaluate(SIG); } catch { continue; }   // mid-navigation
      const diff = now.url !== before.url || now.title !== before.title ||
        Math.abs(now.els - before.els) > 2 || Math.abs(now.len - before.len) > 20;
      if (diff) {
        if (!changedAt) changedAt = Date.now();
        // settle: keep going until two consecutive polls agree
        if (now.url === last.url && now.els === last.els && Math.abs(now.len - last.len) <= 5 && Date.now() - changedAt >= settle_ms) {
          const what: string[] = [];
          if (now.url !== before.url) what.push(`url: ${before.url} → ${now.url}`);
          if (now.title !== before.title) what.push(`title: "${before.title}" → "${now.title}"`);
          if (now.els !== before.els) what.push(`elements: ${before.els} → ${now.els}`);
          if (now.len !== before.len) what.push(`text length: ${before.len} → ${now.len}`);
          return { content: [{ type: "text", text: `Page changed after ~${Date.now() - (deadline - timeout)}ms:\n  ${what.join("\n  ")}` }] };
        }
      }
      last = now;
    }
    return { content: [{ type: "text", text: `No change detected within ${timeout}ms (url ${before.url}, ${before.els} elements). The action may not have registered — check with assert_clickable or a snapshot.` }] };
  });

regTool("assert_clickable",
  "Hit-test an element WITHOUT clicking: would a real click actually land on it? Answers \"why did my click do nothing?\" before you spend the click. " +
  "Reports the element that would intercept the click when something covers it.",
  {
    ref: z.string().default(""),
    selector: z.string().default(""),
  },
  async ({ ref, selector }) => {
    const page = getPage();
    const loc = targetLocator(page, ref, selector);
    if (!loc) return { content: [{ type: "text", text: "Error: ref or selector required" }], isError: true };
    if (await loc.count() === 0) return { content: [{ type: "text", text: `Not found: ${ref ? `ref=${ref}` : selector}` }], isError: true };
    const r = await loc.evaluate((el: any) => {
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const desc = (n: any) => {
        if (!n || !n.tagName) return "(none)";
        let s = n.tagName.toLowerCase();
        if (n.id) s += "#" + n.id;
        else if (typeof n.className === "string" && n.className.trim()) s += "." + n.className.trim().split(/\s+/).slice(0, 2).join(".");
        const t = (n.innerText || "").trim().slice(0, 40);
        return t ? `${s} "${t}"` : s;
      };
      const out: any = {
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
        pointerEvents: cs.pointerEvents, disabled: !!el.disabled,
        inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
        zeroSize: rect.width < 1 || rect.height < 1,
      };
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      if (cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight) {
        const top = document.elementFromPoint(cx, cy);
        out.topAtCenter = desc(top);
        out.hit = !!top && (top === el || el.contains(top) || top.contains(el));
      } else {
        out.topAtCenter = "(centre outside viewport)";
        out.hit = false;
      }
      return out;
    });
    const problems: string[] = [];
    if (r.zeroSize) problems.push("element has zero size");
    if (r.display === "none" || r.visibility === "hidden" || Number(r.opacity) === 0) problems.push(`hidden (display=${r.display} visibility=${r.visibility} opacity=${r.opacity})`);
    if (r.disabled) problems.push("element is disabled");
    if (!r.inViewport) problems.push("outside the viewport — scroll_to it first");
    if (r.pointerEvents === "none") problems.push("pointer-events: none");
    if (!r.hit && r.inViewport && !r.zeroSize) problems.push(`covered by ${r.topAtCenter} — that element would receive the click`);
    const verdict = problems.length === 0 ? "PASS: a real click would reach this element." : `FAIL: ${problems.join("; ")}`;
    return { content: [{ type: "text", text: `${verdict}\n\n${JSON.stringify(r, null, 2)}` }] };
  });

regTool("scroll_to",
  "Scroll a specific element into view (the page-level `scroll` tool only moves by pixels).",
  {
    ref: z.string().default(""),
    selector: z.string().default(""),
    block: z.enum(["start", "center", "end", "nearest"]).default("center"),
  },
  async ({ ref, selector, block }) => {
    const page = getPage();
    const loc = targetLocator(page, ref, selector);
    if (!loc) return { content: [{ type: "text", text: "Error: ref or selector required" }], isError: true };
    if (await loc.count() === 0) return { content: [{ type: "text", text: `Not found: ${ref ? `ref=${ref}` : selector}` }], isError: true };
    await loc.evaluate((el: any, b: string) => el.scrollIntoView({ behavior: "smooth", block: b, inline: "nearest" }), block);
    await page.waitForTimeout(500);
    const pos = await loc.evaluate((el: any) => { const r = el.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)}`; });
    return { content: [{ type: "text", text: `Scrolled ${ref ? `ref=${ref}` : selector} into view (block=${block}); now at ${pos}` }] };
  });

regTool("click_element_offset",
  "Click at a percentage position inside an element instead of its centre — for wide labels whose real checkbox sits at the left edge, sliders, or split buttons.",
  {
    ref: z.string().default(""),
    selector: z.string().default(""),
    x_percent: z.number().default(50).describe("0 = left edge, 100 = right edge"),
    y_percent: z.number().default(50).describe("0 = top edge, 100 = bottom edge"),
  },
  async ({ ref, selector, x_percent, y_percent }) => {
    const page = getPage();
    const loc = targetLocator(page, ref, selector);
    if (!loc) return { content: [{ type: "text", text: "Error: ref or selector required" }], isError: true };
    try { await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT }); } catch {}
    const box = await loc.boundingBox();
    if (!box) return { content: [{ type: "text", text: "Element has no bounding box (hidden?)" }], isError: true };
    const x = box.x + box.width * (Math.min(100, Math.max(0, x_percent)) / 100);
    const y = box.y + box.height * (Math.min(100, Math.max(0, y_percent)) / 100);
    await page.mouse.move(x + 60, y - 40, { steps: 8 });
    await page.mouse.click(x, y);
    await page.waitForTimeout(600);
    return { content: [{ type: "text", text: `Clicked at ${x_percent}%,${y_percent}% of the element → (${Math.round(x)},${Math.round(y)}). URL: ${page.url()}` }] };
  });

regTool("click_at_corner",
  "Click a corner of an element — close/X buttons, delete icons and dismiss controls usually live there, not in the centre.",
  {
    ref: z.string().default(""),
    selector: z.string().default(""),
    corner: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]).default("top-right"),
    offset: z.number().default(8).describe("Inset in pixels from the corner."),
  },
  async ({ ref, selector, corner, offset }) => {
    const page = getPage();
    const loc = targetLocator(page, ref, selector);
    if (!loc) return { content: [{ type: "text", text: "Error: ref or selector required" }], isError: true };
    try { await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT }); } catch {}
    const box = await loc.boundingBox();
    if (!box) return { content: [{ type: "text", text: "Element has no bounding box (hidden?)" }], isError: true };
    const left = corner.endsWith("left");
    const top = corner.startsWith("top");
    const x = left ? box.x + offset : box.x + box.width - offset;
    const y = top ? box.y + offset : box.y + box.height - offset;
    await page.mouse.move(x + 50, y - 30, { steps: 8 });
    await page.mouse.click(x, y);
    await page.waitForTimeout(600);
    return { content: [{ type: "text", text: `Clicked ${corner} corner at (${Math.round(x)},${Math.round(y)}). URL: ${page.url()}` }] };
  });

regTool("paste_text",
  "Fill a field with a REAL paste. Puts the text on the clipboard and presses Ctrl/Cmd+V so the page receives a trusted paste event " +
  "with actual clipboardData — the only thing that works for frameworks that listen to paste alone (Svelte 5 / SolidJS runes, some Qwik forms). " +
  "Falls back to a synthetic event and then the native value setter.",
  {
    ref: z.string().default(""),
    selector: z.string().default(""),
    text: z.string(),
  },
  async ({ ref, selector, text }) => {
    const page = getPage();
    const loc = targetLocator(page, ref, selector);
    if (!loc) return { content: [{ type: "text", text: "Error: ref or selector required" }], isError: true };
    if (await loc.count() === 0) return { content: [{ type: "text", text: `Not found: ${ref ? `ref=${ref}` : selector}` }], isError: true };

    const readValue = () => loc.evaluate((el: any) => ("value" in el ? el.value : (el.textContent || "")));
    // Tier 1 — the real thing: clipboard + trusted Ctrl/Cmd+V.
    try {
      await loc.focus({ timeout: ACTION_TIMEOUT });
      await loc.evaluate((el: any) => { if ("value" in el) el.value = ""; else el.textContent = ""; });
      await page.evaluate((t: string) => navigator.clipboard.writeText(t), text);
      await page.keyboard.press("ControlOrMeta+V");
      await page.waitForTimeout(250);
      if (String(await readValue()) === text) {
        return { content: [{ type: "text", text: `paste_text via real clipboard paste (trusted event) → field matches.` }] };
      }
    } catch {
      // clipboard blocked (older profile without the pref, or no permission) → fall through
    }

    const result = await loc.evaluate((el: any, value: string) => {
      const isField = "value" in el;
      const before = isField ? el.value : (el.textContent || "");
      try { el.focus(); } catch {}
      let pasteHandled = false;
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", value);
        const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt } as any);
        el.dispatchEvent(ev);
        pasteHandled = isField ? el.value !== before : (el.textContent || "") !== before;
      } catch {}
      if (!pasteHandled) {
        if (isField) {
          // Native setter so React's value tracker sees a real change.
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          if (desc && desc.set) desc.set.call(el, value); else el.value = value;
        } else {
          el.textContent = value;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { via: pasteHandled ? "synthetic-paste-event" : "native-setter+input", value: isField ? el.value : (el.textContent || "") };
    }, text);
    const ok = String(result.value) === text;
    const caveat = result.via === "native-setter+input"
      ? " (NOTE: the real clipboard path was unavailable and Firefox won't attach data to a synthetic paste — a field that ONLY listens for paste may still be empty in the app's state)"
      : "";
    return {
      content: [{ type: "text", text: `paste_text via ${result.via} → field now ${ok ? "matches" : `DIFFERS: "${String(result.value).slice(0, 60)}"`}${caveat}` }],
      ...(ok ? {} : { isError: true }),
    };
  });

regTool("form_introspect",
  "Analyse a form in one call: per field the label, type, current value, required/pattern/length constraints, validation state, and the JS framework it is bound to. " +
  "Tells you what to fill and why a submit is being rejected without guessing from a snapshot.",
  {
    form_selector: z.string().default("").describe("CSS selector for the form. Empty = first form, or all top-level fields if the page has none."),
  },
  async ({ form_selector }) => {
    const page = getPage();
    const data = await page.evaluate(`(() => {
      var sel = ${jsStr(form_selector)};
      var form = sel ? document.querySelector(sel) : document.querySelector("form");
      var root = form || document.body;
      var fields = root.querySelectorAll("input:not([type=hidden]), textarea, select");
      function labelFor(el) {
        if (el.id) { var l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]'); if (l) return (l.innerText||"").trim(); }
        var p = el.closest("label"); if (p) return (p.innerText||"").trim();
        if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
        var ab = el.getAttribute("aria-labelledby");
        if (ab) { var t = document.getElementById(ab); if (t) return (t.innerText||"").trim(); }
        return el.placeholder || el.name || el.id || "";
      }
      function framework(el) {
        var keys = Object.keys(el);
        if (keys.some(function(k){return k.indexOf("__react") === 0;})) return "react";
        if (el.__vue__ || el.__vnode || keys.some(function(k){return k.indexOf("__vue") === 0;})) return "vue";
        if (el.__svelte_meta || keys.some(function(k){return k.indexOf("$$") === 0;})) return "svelte";
        if (keys.some(function(k){return k.indexOf("_$") === 0;})) return "solid";
        if (el.closest("[data-qwik], [q\\\\:container]")) return "qwik";
        return "";
      }
      var out = [];
      for (var i = 0; i < fields.length && i < 40; i++) {
        var el = fields[i];
        var v;
        try { v = el.validity; } catch (e) { v = null; }
        out.push({
          label: labelFor(el).slice(0, 60),
          tag: el.tagName.toLowerCase(),
          type: el.type || "",
          name: el.name || "",
          id: el.id || "",
          value: String(el.value || "").slice(0, 60),
          required: !!el.required,
          disabled: !!el.disabled,
          readonly: !!el.readOnly,
          pattern: el.getAttribute("pattern") || "",
          minlength: el.getAttribute("minlength") || "",
          maxlength: el.getAttribute("maxlength") || "",
          valid: v ? v.valid : null,
          validationMessage: el.validationMessage || "",
          framework: framework(el),
        });
      }
      return {
        form_found: !!form,
        action: form ? (form.action || "") : "",
        method: form ? (form.method || "") : "",
        field_count: fields.length,
        fields: out,
      };
    })()`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

regTool("smart_fill",
  "Fill form fields by their LABEL text (fuzzy, case-insensitive) instead of refs — no snapshot needed. " +
  "Values go through the same clearing logic as fill, so email/number fields replace rather than append.",
  {
    fields_json: z.string().describe('JSON object of {"Label": "value", …}, e.g. {"Email":"a@b.com","Password":"secret"}'),
    within: z.string().default("").describe('Scope: "@dialog", "ref:e5", or a CSS selector.'),
    submit_label: z.string().default("").describe("If set, click the button whose text matches after filling."),
  },
  async ({ fields_json, within, submit_label }) => {
    const page = getPage();
    let fields: Record<string, string>;
    try {
      fields = JSON.parse(fields_json);
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("expected a JSON object");
    } catch (e: any) {
      return { content: [{ type: "text", text: `Invalid fields_json: ${e?.message || e}` }], isError: true };
    }
    const scopeSel = within === "@dialog" ? '[role="dialog"], dialog[open], [aria-modal="true"]'
      : within.startsWith("ref:") ? `[data-mcp-ref="${within.slice(4)}"]` : within;
    const log: string[] = [];
    for (const [label, value] of Object.entries(fields)) {
      // Resolve the label to a concrete field IN THE PAGE, then tag it with a ref
      // so the fill goes through the normal locator path.
      const ref = await page.evaluate(`(() => {
        var scopeSel = ${jsStr(scopeSel)};
        var root = scopeSel ? (document.querySelector(scopeSel) || document) : document;
        var want = ${jsStr(label)}.toLowerCase().trim();
        var fields = root.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select");
        function labelOf(el) {
          var parts = [];
          if (el.id) { var l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]'); if (l) parts.push(l.innerText || ""); }
          var p = el.closest("label"); if (p) parts.push(p.innerText || "");
          parts.push(el.getAttribute("aria-label") || "", el.placeholder || "", el.name || "", el.id || "");
          return parts.join(" ").toLowerCase();
        }
        var exact = null, partial = null;
        for (var i = 0; i < fields.length; i++) {
          var t = labelOf(fields[i]).trim();
          if (!t) continue;
          if (t === want) { exact = fields[i]; break; }
          if (!partial && t.indexOf(want) !== -1) partial = fields[i];
        }
        var el = exact || partial;
        if (!el) return "";
        var ref = "sf" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
        el.setAttribute("data-mcp-ref", ref);
        return ref;
      })()`) as string;
      if (!ref) { log.push(`"${label}": NO FIELD MATCHED`); continue; }
      try {
        await fillLocator(refLocator(page, ref), value);
        log.push(`"${label}": filled`);
      } catch (e: any) {
        log.push(`"${label}": FAILED — ${String(e?.message || e).slice(0, 80)}`);
      }
    }
    let submitNote = "";
    if (submit_label) {
      const loc = scopeRoot(page, within).getByText(submit_label, { exact: false });
      const n = await loc.count();
      if (n === 0) submitNote = `\nsubmit: no element matched "${submit_label}"`;
      else {
        const mode = await clickWithFallback(loc.first());
        await page.waitForTimeout(1000);
        submitNote = `\nsubmit: clicked "${submit_label}"${n > 1 ? ` (${n} matched, took the first)` : ""}${clickNote(mode)}`;
      }
    }
    const failed = log.filter(l => l.includes("NO FIELD") || l.includes("FAILED")).length;
    return {
      content: [{ type: "text", text: `smart_fill: ${log.length - failed}/${log.length} filled\n  ${log.join("\n  ")}${submitNote}\nURL: ${page.url()}` }],
      ...(failed ? { isError: true } : {}),
    };
  });

// ── Persistent dialog handling ─────────────────────────────────────────────

let autoDialogCfg: { action: "accept" | "dismiss"; promptText: string } | null = null;
let autoDialogHandler: ((d: Dialog) => void) | null = null;
let oneShotDialogArmed = false;

regTool("dialog_auto_handle",
  "Install a PERSISTENT dialog handler that stays armed across every dialog and every tab (dialog_handle is one-shot). " +
  "Reads its action at fire time, so you can change it without re-arming. Set enabled=false to remove it.",
  {
    action: z.enum(["accept", "dismiss"]).default("accept"),
    prompt_text: z.string().default("").describe("Text to submit for prompt() dialogs."),
    enabled: z.boolean().default(true),
  },
  async ({ action, prompt_text, enabled }) => {
    if (!browserUp) throw new Error("Browser not running. Call browser_launch first.");
    if (!enabled) {
      if (autoDialogHandler) for (const p of pages) { try { p.off("dialog", autoDialogHandler); } catch {} }
      autoDialogHandler = null; autoDialogCfg = null;
      return { content: [{ type: "text", text: "Persistent dialog handler removed. Dialogs fall back to Playwright's auto-dismiss." }] };
    }
    autoDialogCfg = { action, promptText: prompt_text };
    if (!autoDialogHandler) {
      autoDialogHandler = async (dialog: Dialog) => {
        // A one-shot dialog_handle takes precedence for the next dialog.
        if (oneShotDialogArmed) return;
        const cfg = autoDialogCfg;
        if (!cfg) { try { await dialog.dismiss(); } catch {} return; }
        try {
          if (cfg.action === "accept") await dialog.accept(cfg.promptText);
          else await dialog.dismiss();
        } catch {}
      };
      for (const p of pages) p.on("dialog", autoDialogHandler);
    }
    return { content: [{ type: "text", text: `Persistent dialog handler armed: every dialog will be ${action}'d (${pages.length} tab(s), new tabs inherit it). Call with enabled=false to remove.` }] };
  });

regTool("sessionstorage_clear", "Clear all sessionStorage for the current origin (parity with localstorage_clear).", {}, async () => {
  const page = getPage();
  const n = await page.evaluate(`(() => { var n = sessionStorage.length; sessionStorage.clear(); return n; })()`);
  return { content: [{ type: "text", text: `sessionStorage cleared (${n} key(s) removed).` }] };
});

regTool("wait_for_request",
  "Block until the page ISSUES a request matching a URL substring (wait_for_response waits for the reply). " +
  "Use it to confirm an action actually fired its API call.",
  {
    url_pattern: z.string(),
    method: z.string().default("").describe("Optional HTTP verb filter (GET/POST/…)"),
    timeout: z.number().default(15000),
  },
  async ({ url_pattern, method, timeout }) => {
    const page = getPage();
    try {
      const req = await page.waitForRequest(
        (r: any) => r.url().includes(url_pattern) && (!method || r.method().toUpperCase() === method.toUpperCase()),
        { timeout });
      const post = req.postData();
      return { content: [{ type: "text", text: `Request: ${req.method()} ${req.url().slice(0, 200)}${post ? `\nbody: ${post.slice(0, 500)}` : ""}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `No request matching "${url_pattern}"${method ? ` (${method})` : ""} within ${timeout}ms.` }], isError: true };
    }
  });

// ── Storage snapshot / diff ────────────────────────────────────────────────

const storageSnapshots = new Map<string, any>();

async function captureStorage(page: Page): Promise<any> {
  const web = await page.evaluate(`(() => {
    var l = {}, s = {};
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); l[k] = localStorage.getItem(k); } } catch (e) {}
    try { for (var j = 0; j < sessionStorage.length; j++) { var k2 = sessionStorage.key(j); s[k2] = sessionStorage.getItem(k2); } } catch (e) {}
    return { url: location.href, local: l, session: s };
  })()`) as any;
  let cookies: any[] = [];
  try { cookies = await page.context().cookies(); } catch {}
  return { ...web, cookies: Object.fromEntries(cookies.map((c: any) => [`${c.domain}${c.path}:${c.name}`, String(c.value)])) };
}

function diffMaps(before: Record<string, string>, after: Record<string, string>) {
  const added: any = {}, removed: any = {}, changed: any = {};
  for (const k of Object.keys(after)) {
    if (!(k in before)) added[k] = String(after[k]).slice(0, 120);
    else if (before[k] !== after[k]) changed[k] = { from: String(before[k]).slice(0, 60), to: String(after[k]).slice(0, 60) };
  }
  for (const k of Object.keys(before)) if (!(k in after)) removed[k] = String(before[k]).slice(0, 120);
  return { added, removed, changed };
}

regTool("storage_snapshot",
  "Capture cookies + localStorage + sessionStorage + URL into a named slot, so storage_diff can tell you exactly what an action changed.",
  { name: z.string().default("default") },
  async ({ name }) => {
    const page = getPage();
    const snap = await captureStorage(page);
    storageSnapshots.set(name, snap);
    return { content: [{ type: "text", text: `Snapshot "${name}": ${Object.keys(snap.cookies).length} cookies, ${Object.keys(snap.local).length} localStorage, ${Object.keys(snap.session).length} sessionStorage @ ${snap.url}` }] };
  });

regTool("storage_diff",
  "Compare current storage against an earlier storage_snapshot — shows exactly which cookies/localStorage/sessionStorage keys were added, removed or changed. " +
  "The fastest way to find which key holds a session token.",
  { name: z.string().default("default") },
  async ({ name }) => {
    const page = getPage();
    const before = storageSnapshots.get(name);
    if (!before) {
      const have = [...storageSnapshots.keys()];
      return { content: [{ type: "text", text: `No snapshot named "${name}".${have.length ? ` Available: ${have.join(", ")}` : " Call storage_snapshot first."}` }], isError: true };
    }
    const after = await captureStorage(page);
    const out = {
      url: before.url === after.url ? after.url : { from: before.url, to: after.url },
      cookies: diffMaps(before.cookies, after.cookies),
      localStorage: diffMaps(before.local, after.local),
      sessionStorage: diffMaps(before.session, after.session),
    };
    const count = (d: any) => Object.keys(d.added).length + Object.keys(d.removed).length + Object.keys(d.changed).length;
    const total = count(out.cookies) + count(out.localStorage) + count(out.sessionStorage);
    return { content: [{ type: "text", text: `storage_diff vs "${name}": ${total} change(s)\n${JSON.stringify(out, null, 2)}` }] };
  });

// ── IndexedDB ──────────────────────────────────────────────────────────────

regTool("indexeddb_list",
  "List IndexedDB databases for the current origin. Many SPAs keep auth state and drafts here, invisible to cookie/localStorage tools.",
  {}, async () => {
    const page = getPage();
    const dbs = await page.evaluate(`(async () => {
      if (typeof indexedDB.databases !== "function") return { unsupported: true };
      try { return { dbs: await indexedDB.databases() }; } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) as any;
    if (dbs?.unsupported) return { content: [{ type: "text", text: "This browser build can't enumerate IndexedDB databases (indexedDB.databases unavailable). You can still delete one by name with indexeddb_delete." }] };
    if (dbs?.error) return { content: [{ type: "text", text: `IndexedDB error: ${dbs.error}` }], isError: true };
    const list = dbs?.dbs || [];
    if (!list.length) return { content: [{ type: "text", text: "No IndexedDB databases for this origin." }] };
    return { content: [{ type: "text", text: `IndexedDB (${list.length}):\n${list.map((d: any) => `  ${d.name}  v${d.version}`).join("\n")}` }] };
  });

regTool("indexeddb_delete",
  "Delete an IndexedDB database by name for the current origin (clears SPA state that survives a cookie wipe).",
  { name: z.string() },
  async ({ name }) => {
    const page = getPage();
    const res = await page.evaluate(`(async () => {
      return await new Promise(function (resolve) {
        var req = indexedDB.deleteDatabase(${jsStr(name)});
        var done = false;
        req.onsuccess = function () { done = true; resolve("deleted"); };
        req.onerror = function () { done = true; resolve("error"); };
        req.onblocked = function () { done = true; resolve("blocked (a tab still holds a connection)"); };
        setTimeout(function () { if (!done) resolve("timeout"); }, 5000);
      });
    })()`) as string;
    const ok = res === "deleted";
    return { content: [{ type: "text", text: `indexeddb_delete("${name}"): ${res}` }], ...(ok ? {} : { isError: true }) };
  });

regTool("performance_timeline",
  "Navigation + paint + resource timing for the current page: TTFB, DOMContentLoaded, load, FCP, LCP, and the 5 slowest resources. " +
  "Note: Firefox does not implement layout-shift, so CLS is unavailable here.",
  {}, async () => {
    const page = getPage();
    const data = await page.evaluate(`(() => {
      var nav = performance.getEntriesByType("navigation")[0] || null;
      var paints = {};
      performance.getEntriesByType("paint").forEach(function (p) { paints[p.name] = Math.round(p.startTime); });
      var lcp = null;
      try {
        var l = performance.getEntriesByType("largest-contentful-paint");
        if (l && l.length) lcp = Math.round(l[l.length - 1].startTime);
      } catch (e) {}
      var res = performance.getEntriesByType("resource").map(function (r) {
        return { name: String(r.name).slice(0, 120), type: r.initiatorType, ms: Math.round(r.duration), size: r.transferSize || 0 };
      }).sort(function (a, b) { return b.ms - a.ms; });
      return {
        url: location.href,
        ttfb_ms: nav ? Math.round(nav.responseStart - nav.requestStart) : null,
        dom_content_loaded_ms: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        load_ms: nav ? Math.round(nav.loadEventEnd) : null,
        dom_interactive_ms: nav ? Math.round(nav.domInteractive) : null,
        transfer_size: nav ? nav.transferSize : null,
        first_paint_ms: paints["first-paint"] != null ? paints["first-paint"] : null,
        first_contentful_paint_ms: paints["first-contentful-paint"] != null ? paints["first-contentful-paint"] : null,
        largest_contentful_paint_ms: lcp,
        cumulative_layout_shift: "unsupported-in-firefox",
        resource_count: res.length,
        slowest_resources: res.slice(0, 5)
      };
    })()`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

regTool("browser_recover",
  "Escape hatch when the browser is wedged and browser_close can't complete: force-drops the connection and resets server state so browser_launch works again. " +
  "Also reports a profile lock held by another Camoufox process, which is the usual cause of 'A copy of Camoufox is already open'.",
  {}, async () => {
    const steps: string[] = [];
    if (browserContext) {
      try {
        await Promise.race([browserContext.close(), new Promise(r => setTimeout(r, 5000))]);
        steps.push("context close attempted");
      } catch (e: any) { steps.push(`context close failed (ignored): ${String(e?.message || e).slice(0, 80)}`); }
    } else steps.push("no context held");
    if (activeProfileIsTemp && activeProfileDir) {
      try { rmSync(activeProfileDir, { recursive: true, force: true }); steps.push("temp profile removed"); } catch { steps.push("temp profile removal failed"); }
    }
    browserContext = null; pages = []; activePage = 0; browserUp = false;
    activeProfileDir = null; activeProfileIsTemp = false;
    consoleMessages.length = 0; networkRequests.length = 0; networkSeq = 0;
    networkCaptureBodies = false; networkHandler = null; consoleHandler = null;
    autoDialogHandler = null; autoDialogCfg = null; oneShotDialogArmed = false;
    steps.push("server state reset");
    // A stale lock file means another Camoufox still owns the shared profile.
    let lockNote = "";
    try {
      const { existsSync } = await import("fs");
      if (existsSync(`${PROFILE_DIR}/parent.lock`) || existsSync(`${PROFILE_DIR}/.parentlock`)) {
        lockNote = `\nNOTE: a lock file still exists in ${PROFILE_DIR}. If browser_launch keeps failing with "A copy of Camoufox is already open", another Camoufox process owns that profile — launch with fresh_profile=true, or close the other browser.`;
      }
    } catch {}
    return { content: [{ type: "text", text: `browser_recover:\n  ${steps.join("\n  ")}\nYou can call browser_launch again.${lockNote}` }] };
  });

regTool("workflow_run",
  "Run a list of tool calls in sequence — any tool this server exposes, by name — and return a per-step log. " +
  "Resumable: a failed run tells you the index, and start_at skips the steps that already succeeded. " +
  'Each step is {"tool":"navigate","args":{"url":"…"},"label":"optional"}.',
  {
    steps: z.array(z.object({
      tool: z.string(),
      args: z.record(z.string(), z.any()).default({}),
      label: z.string().default(""),
    })).describe("Steps to execute in order."),
    start_at: z.number().default(0).describe("Skip the first N steps (resume after a failure)."),
    stop_on_error: z.boolean().default(true),
  },
  async ({ steps, start_at, stop_on_error }) => {
    const log: string[] = [];
    let ran = 0, failed = 0;
    for (let i = Math.max(0, start_at); i < steps.length; i++) {
      const step = steps[i];
      const label = step.label || step.tool;
      if (step.tool === "workflow_run") { log.push(`[${i}] ${label}: REFUSED — cannot nest workflow_run`); failed++; if (stop_on_error) break; continue; }
      const entry = toolRegistry.get(step.tool);
      if (!entry) { log.push(`[${i}] ${label}: UNKNOWN TOOL`); failed++; if (stop_on_error) { log.push(`stopped — fix the name and resume with start_at=${i}`); break; } continue; }
      let args: any;
      try { args = z.object(entry.schema).parse(step.args ?? {}); }
      catch (e: any) { log.push(`[${i}] ${label}: BAD ARGS — ${String(e?.message || e).replace(/\s+/g, " ").slice(0, 200)}`); failed++; if (stop_on_error) { log.push(`stopped — resume with start_at=${i}`); break; } continue; }
      try {
        const res: any = await entry.handler(args, {});
        const text = (res?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
        ran++;
        if (res?.isError) {
          failed++;
          log.push(`[${i}] ${label}: ERROR — ${String(text).replace(/\s+/g, " ").slice(0, 220)}`);
          if (stop_on_error) { log.push(`stopped — resume with start_at=${i} after fixing it`); break; }
        } else {
          log.push(`[${i}] ${label}: OK — ${String(text).replace(/\s+/g, " ").slice(0, 220)}`);
        }
      } catch (e: any) {
        failed++;
        log.push(`[${i}] ${label}: THREW — ${String(e?.message || e).replace(/\s+/g, " ").slice(0, 220)}`);
        if (stop_on_error) { log.push(`stopped — resume with start_at=${i}`); break; }
      }
    }
    return {
      content: [{ type: "text", text: `workflow_run: ${ran} step(s) executed, ${failed} failed (of ${steps.length} total)\n${log.join("\n")}` }],
      ...(failed ? { isError: true } : {}),
    };
  });

// ── Start Server ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-camoufox] Server running on stdio...");
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch((err) => {
  console.error("[mcp-camoufox] Fatal:", err);
  process.exit(1);
});
