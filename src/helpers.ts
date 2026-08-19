// Pure-ish helpers shared by the tool modules: refs, clicks, fills, snapshots,
// paths, TOTP. Only trackPage/inflight touch shared state.
import type { Page } from "playwright-core";
import { S, HOME_DIR, PROFILE_DIR, SCREENSHOT_DIR } from "./state.js";

import { mkdirSync, writeFileSync, rmSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { createHmac } from "crypto";
import { createRequire } from "module";

// Real package version — read at runtime so the MCP handshake never drifts from
// package.json (npm always ships package.json next to dist/).
export const PKG_VERSION: string = (() => {
  try { return createRequire(import.meta.url)("../package.json").version || "0.0.0"; }
  catch { return "0.0.0"; }
})();

// Shared default timeout for element actions (click/fill/check/etc.).
export const ACTION_TIMEOUT = 5000;

// Upper bound on one snapshot's rendered element list. 60k characters is large
// enough for any ordinary page and small enough that a 6,000-element dashboard
// can no longer blow up the response.
export const MAX_SNAPSHOT_CHARS = 60000;

export function ensureDirs() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// Safely embed a JS string literal inside an evaluate() source string. Manual
// quote-escaping breaks on backslashes/newlines/quotes; JSON.stringify doesn't.
export function jsStr(s: string): string {
  return JSON.stringify(s ?? "");
}

// A user-supplied *name* must never escape its directory. `screenshot` and
// `auth_capture` join a name into a fixed folder, so "../../../../etc/x" used to
// write anywhere the process could reach — an arbitrary-write primitive for an
// agent that has only this MCP server and no shell.
export function safeName(name: string, fallback = "file"): string {
  const cleaned = String(name || "")
    .replace(/[\\/]/g, "_")      // no path separators
    .replace(/^\.+/, "")          // no leading dots ("..", ".hidden")
    .replace(/[\x00-\x1f]/g, "")  // no control chars
    .trim()
    .slice(0, 100);
  return cleaned || fallback;
}

// Cookies and storage states ARE credentials. Default 0644 let any other local
// user read a captured login; write them 0600.
export function writeSecretFile(target: string, data: string): void {
  writeFileSync(target, data, { mode: 0o600 });
  try { chmodSync(target, 0o600); } catch {}   // pre-existing file keeps its old mode otherwise
}

// Expand a leading ~ only (a bare .replace("~", HOME) would rewrite a tilde
// anywhere in the path, e.g. "/tmp/a~b.json").
export function expandHome(p: string): string {
  if (p === "~") return HOME_DIR;
  if (p.startsWith("~/")) return HOME_DIR + p.slice(1);
  return p;
}

// Expand ~, create the parent directory, return the absolute target path.
export function resolveOutPath(p: string): string {
  const target = expandHome(p);
  // dirname(), not a manual lastIndexOf("/") — on Windows a path like
  // C:\Users\bob\out\state.json has no forward slash at all, so the old
  // version computed an empty directory, skipped mkdir, and the write failed
  // whenever the folder didn't already exist (issue #5).
  const dir = dirname(target);
  if (dir && dir !== "." && dir !== target) mkdirSync(dir, { recursive: true });
  return target;
}

// Runs before every page script on every navigation — populates the buffer that
// get_page_errors reads. Without this the tool always returned [].
export const ERROR_HOOK_JS = `(() => {
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
export function base32Decode(s: string): Buffer {
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
export function totpFromSecret(secret: string, step = 30, digits = 6): string {
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
export type ClickMode = "real" | "fallback";
export async function clickWithFallback(
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
export function clickNote(mode: ClickMode): string {
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
export async function fillLocator(loc: any, value: string): Promise<void> {
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
export function refLocator(page: Page, ref: string) {
  return page.locator(`[data-mcp-ref="${ref}"]`).first();
}

// Search root for text/role/label lookups, so a click can be confined to the
// dialog the user is actually looking at instead of matching the whole page.
//   ""        → whole page
//   "@dialog" → topmost visible dialog/modal
//   "ref:e5"  → a snapshot ref
//   otherwise → CSS selector
export function scopeRoot(page: Page, within?: string): any {
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
export async function describeMatches(loc: any, cap = 8): Promise<{ total: number; items: any[] }> {
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

export function candidateList(total: number, items: any[]): string {
  const lines = items.map(c =>
    `  index=${c.index} ref=${c.ref}  [${c.tag}${c.role ? ` role=${c.role}` : ""}] "${c.text}"  at ${c.at}${c.visible ? "" : " (hidden)"}\n      in: ${c.path}`);
  const more = total > items.length ? `\n  … ${total - items.length} more` : "";
  return lines.join("\n") + more;
}

// Per-page in-flight request counter, armed the moment a page is tracked.
// wait_for_network_idle used to attach its own listeners at call time and start
// counting from zero, so a request that was ALREADY in flight looked like idle.
export const inflightByPage = new WeakMap<Page, { n: number }>();
export function inflightOf(p: Page): number { return inflightByPage.get(p)?.n ?? 0; }

export type WaitUntil = "domcontentloaded" | "load" | "networkidle";

/** Wait for a page to be ready WITHOUT relying on Playwright's lifecycle events.
 *
 *  Camoufox stops delivering `load` and `domcontentloaded` to Juggler after the
 *  fifth page in a context — measured, with a fresh browser per run: both events
 *  succeed 4 times and then fail every time after (8/12 timing out at 30s), while
 *  `commit` plus this poll passes 12/12 with the DOM verified present. Anything
 *  that waited on those events burned its entire timeout on a page that had in
 *  fact loaded fine, which is why navigate/tab_new/reload/go_back all broke for
 *  anyone who opened five tabs.
 *
 *  So: commit the navigation (which does not depend on those events), then ask
 *  the document itself. networkidle uses the same per-page in-flight counter as
 *  wait_for_network_idle rather than the equally-dead lifecycle event. */
export async function waitReady(page: Page, waitUntil: WaitUntil, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  // "load" wants a fully loaded document; the other two only need it parsed.
  const cond = waitUntil === "load"
    ? `(() => { return document.readyState === "complete"; })()`
    : `(() => { var s = document.readyState; return s === "interactive" || s === "complete"; })()`;
  await page.waitForFunction(cond, null, { timeout: Math.max(1000, deadline - Date.now()) });
  if (waitUntil !== "networkidle") return;
  // Same rule as wait_for_network_idle: quiet for 500ms continuously.
  let quietSince = inflightOf(page) === 0 ? Date.now() : 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    if (inflightOf(page) === 0) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= 500) return;
    } else quietSince = 0;
  }
}

/** goto + waitReady. Every navigation in this server goes through here. */
export async function gotoReady(
  page: Page, url: string, waitUntil: WaitUntil = "domcontentloaded", timeout = 30000,
): Promise<void> {
  await page.goto(url, { waitUntil: "commit", timeout });
  await waitReady(page, waitUntil, timeout);
}

// Track a page in the global S.pages[] list and auto-remove it on close.
// Used for the initial page, tab_new, AND pages opened by the site itself
// (window.open / target=_blank) via the browserContext "page" event — without
// this, popup/OAuth windows are invisible to every tool. Idempotent.
// If console/network capture is active, the new page inherits the handlers so
// capture follows the user across tabs and popups.
export function trackPage(p: Page): void {
  if (S.pages.includes(p)) return;
  S.pages.push(p);
  if (S.consoleHandler) p.on("console", S.consoleHandler);
  if (S.networkHandler) p.on("response", S.networkHandler);
  // A persistent dialog handler must cover tabs the site opens later too,
  // otherwise a popup's confirm() hangs the flow.
  if (S.autoDialogHandler) p.on("dialog", S.autoDialogHandler);
  // A one-shot dialog_handle promises the next dialog on ANY tab — including one
  // opened after it was armed, which would otherwise hang with no handler at all.
  if (S.oneShotDialogHandler) p.on("dialog", S.oneShotDialogHandler);
  const inflight = { n: 0 };
  inflightByPage.set(p, inflight);
  p.on("request", () => { inflight.n++; });
  p.on("requestfinished", () => { if (inflight.n > 0) inflight.n--; });
  p.on("requestfailed", () => { if (inflight.n > 0) inflight.n--; });
  p.once("close", () => {
    const i = S.pages.indexOf(p);
    if (i < 0) return;
    // Preserve which page is active by IDENTITY, not index — removing a
    // lower-indexed page (e.g. a popup that closed itself) must not silently
    // shift the active page onto a different tab.
    const activeObj = S.pages[S.activePage];
    S.pages.splice(i, 1);
    const reFound = S.pages.indexOf(activeObj);
    S.activePage = reFound >= 0 ? reFound : Math.min(S.activePage, S.pages.length - 1);
    if (S.activePage < 0) S.activePage = 0;
  });
}

// DOM snapshot JS — IIFE so page.evaluate runs it immediately
export const SNAPSHOT_JS = `(() => {
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
      text: (function () {
        var t = el.innerText || '';
        if (t) return t.trim().slice(0, 100);
        var v = el.value || '';
        if (!v) return '';
        // A password/secret field's VALUE must never leave the browser: masking
        // it only in fill() was pointless while every snapshot printed it.
        var ty = (el.type || '').toLowerCase();
        var hint = ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('autocomplete') || '')).toLowerCase();
        if (ty === 'password' || /pass|secret|token|otp|cvv|card|pin/.test(hint)) return '••• ' + v.length + ' chars (masked)';
        return v.trim().slice(0, 100);
      })(),
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

export function formatSnapshot(
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
  // Size guard: a dashboard-scale page produced a 566,000-character snapshot with
  // no warning at all — hundreds of thousands of tokens, silently. Stop at a
  // budget and say exactly how to get the rest, instead of flooding the caller.
  let budget = MAX_SNAPSHOT_CHARS;
  let rendered = 0;
  let truncatedBySize = false;
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
    const line = `  ref=${el.ref}  ${parts.join(" ")}`;
    if (budget - line.length < 0) { truncatedBySize = true; break; }
    budget -= line.length + 1;
    lines.push(line);
    rendered++;
  }
  const shownEnd = offset + rendered;
  if (truncatedBySize) {
    lines.push("", `… stopped at ${rendered} elements (~${MAX_SNAPSHOT_CHARS / 1000}k chars) — ${matched - shownEnd} still unshown.`,
      `Continue with browser_snapshot(offset=${shownEnd}), narrow with roles=["button","textbox"], or on a page this size prefer page_stats / extract_structured / scrape_page.`);
  } else if (matched > shownEnd) {
    lines.push("", `… ${matched - shownEnd} more — call browser_snapshot with offset=${shownEnd}`);
  }
  return lines.join("\n");
}

// Run the DOM snapshot and format it — the evaluate(SNAPSHOT_JS)+formatSnapshot
// pair used by browser_snapshot and every *_and_snapshot compound tool.
export async function snapshotPage(
  page: Page,
  opts?: { roles?: string[]; offset?: number; limit?: number },
): Promise<string> {
  const elements = (await page.evaluate(SNAPSHOT_JS)) || [];
  return formatSnapshot(elements as any[], page.url(), await page.title(), opts);
}
