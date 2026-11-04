// Pure-ish helpers shared by the tool modules: refs, clicks, fills, snapshots,
// paths, TOTP. Only trackPage/inflight touch shared state.
import type { Page } from "playwright-core";
import { S, HOME_DIR, PROFILE_DIR, SCREENSHOT_DIR, dialogLog } from "./state.js";
import { scrubErrorText } from "./redact.js";

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

// A secret-looking field, as a function source to splice into evaluate strings. Its
// value must not reach a reply through any tool, so there is one definition of it.
export const SECRET_FIELD_FN = `function (el) {
  var ty = String(el.type || "").toLowerCase();
  var hint = (String(el.name || "") + " " + String(el.id || "") + " " + String((el.getAttribute && el.getAttribute("autocomplete")) || "") + " " + String((el.getAttribute && el.getAttribute("aria-label")) || "")).toLowerCase();
  return ty === "password" || /pass|secret|token|otp|cvv|card|pin/.test(hint);
}`;

/** Does this element hold a secret? Read through the shared definition. */
export async function isSecretLocator(loc: any): Promise<boolean> {
  try { return !!(await loc.evaluate(elementFn(`return (${SECRET_FIELD_FN})(el);`), undefined, { timeout: ACTION_TIMEOUT })); }
  catch { return false; }
}

/** A locator.evaluate function built from source, so SECRET_FIELD_FN can be spliced in.
 *  It must be a real function: a string here is evaluated and never called on Firefox,
 *  and the tool then quietly gets undefined back. */
export function elementFn(body: string): (el: any) => any {
  return new Function("el", body) as any;
}

// What a tool may say about a value that might be secret.
export function maskedField(length: number): string {
  return `••• ${length} chars (masked)`;
}

// Click a locator, falling back to synthetic events when Playwright's actionability
// check fails because something covers the target (overlay, a portal that just mounted).
//
// Returns which path was used so callers can SAY SO. The old version fell back to a
// bare el.click() and still reported "Clicked". Pointer-driven widgets (Radix,
// Headless UI, MUI) ignore that entirely, so the fallback replays the full pointer
// sequence.
//
// The fallback is refused when it could only mislead: a disabled control ignores it,
// a hidden one would fire a handler no user could reach, and a blocked right or double
// click must not silently become the left click it would replay.
export type ClickMode = "real" | "fallback";
export interface ClickResult { mode: ClickMode; blocker?: string; }

/** The element Playwright says took the pointer, from its failure log. */
function interceptorIn(message: string): string {
  const m = scrubErrorText(message).match(/(<[^\n]*?>)[^\n]*?(?:subtree )?intercepts pointer events/);
  return m ? m[1].slice(0, 140) : "";
}

export async function clickWithFallback(
  loc: any,
  opts?: { button?: "left" | "right" | "middle"; dblclick?: boolean },
): Promise<ClickResult> {
  const button = opts?.button || "left";
  try {
    if (opts?.dblclick) await loc.dblclick({ button, timeout: ACTION_TIMEOUT });
    else await loc.click({ button, timeout: ACTION_TIMEOUT });
    return { mode: "real" };
  } catch (err: any) {
    const why = String(err?.message || err);
    if (await loc.count().catch(() => 0) === 0) {
      throw new Error("Element not found. The ref may be from an older snapshot: call browser_snapshot again.");
    }
    const state = await loc.evaluate((el: any) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        disabled: !!el.matches?.(":disabled") || el.getAttribute?.("aria-disabled") === "true",
        hidden: cs.display === "none" || cs.visibility === "hidden" || r.width < 1 || r.height < 1,
      };
    }, undefined, { timeout: ACTION_TIMEOUT });
    if (state.disabled) throw new Error("Not clicked: the element is disabled, so a click would do nothing. Nothing was fired.");
    if (state.hidden) throw new Error("Not clicked: the element is hidden (display, visibility or zero size). Nothing was fired. Take a new browser_snapshot, or click the visible control that stands for it.");
    const blocker = interceptorIn(why);
    if (button !== "left" || opts?.dblclick) {
      throw new Error(`Not clicked: the real ${opts?.dblclick ? "double " : ""}${button} click was blocked${blocker ? ` by ${blocker}` : ""}, and no synthetic fallback exists for it. Nothing was fired.`);
    }
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
    return { mode: "fallback", blocker };
  }
}

// Suffix appended to every click result so a degraded click is never silent.
export function clickNote(result: ClickResult): string {
  return result.mode === "real"
    ? ""
    : ` ⚠ the real mouse click was blocked${result.blocker ? ` by ${result.blocker}` : ""}, so synthetic pointer events were dispatched on the element instead. Dismiss the blocker first if the widget ignores them.`;
}

// What a click did, read from the page. Only a hash leaves the page, so a form's
// values cannot reach a reply through this. Comparing lengths read a counter going
// from 1 to 2 as no change. Focus is left out on purpose: focus dropping to <body> is
// what clicking anything unfocusable does, not a reaction. Scroll is left out because
// Playwright scrolls a target into view before clicking it.
const PAGE_SIGNATURE_JS = `(function () {
  var h = 2166136261;
  function add(t) { for (var i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } }
  add(document.documentElement ? document.documentElement.outerHTML : "");
  var f = document.querySelectorAll("input, textarea, select");
  for (var j = 0; j < f.length; j++) add(String(f[j].value) + (f[j].checked ? "1" : "0"));
  return document.title + "|" + (h >>> 0);
})()`;

async function pageSignature(page: Page): Promise<string | null> {
  try {
    return await Promise.race([
      page.evaluate(PAGE_SIGNATURE_JS) as Promise<string>,
      new Promise<null>(r => setTimeout(() => r(null), 1500)),
    ]);
  } catch { return null; }
}

export interface ClickOutcome { changed: boolean; note: string; }

/** Run a click and report what the page did. Waits up to waitMs but returns as soon
 *  as something reacted. A new tab changes nothing on its own page, so tabs are watched
 *  too, or a working popup button reads as dead and an agent clicks it again. */
export async function observeClick(page: Page, click: () => Promise<void>, waitMs = 1000): Promise<ClickOutcome> {
  const ctx = page.context();
  const pagesBefore = new Set(ctx.pages());
  const urlBefore = page.url();
  const seqBefore = navSeqOf(page);
  const sigBefore = await pageSignature(page);
  await click();
  const deadline = Date.now() + waitMs;
  const opened = () => ctx.pages().filter(p => !pagesBefore.has(p));
  for (;;) {
    await page.waitForTimeout(50).catch(() => {});
    if (page.isClosed()) return { changed: true, note: "The tab closed itself." };
    const navigated = page.url() !== urlBefore || navSeqOf(page) !== seqBefore;
    if (opened().length) {
      const fresh = opened()[0];
      // A popup starts on about:blank and gets its address a moment later.
      for (let i = 0; i < 20 && fresh.url() === "about:blank"; i++) await page.waitForTimeout(50).catch(() => {});
      return { changed: true, note: `Opened a new tab [${S.pages.indexOf(fresh)}]: ${fresh.url()}. The active tab did not change; use tab_select to switch.` };
    }
    if (navigated) return { changed: true, note: `Page navigated to ${page.url()}.` };
    const sig = await pageSignature(page);
    if (sig !== null && sigBefore !== null && sig !== sigBefore) return { changed: true, note: "Page content changed." };
    if (Date.now() >= deadline) break;
  }
  if (sigBefore === null) return { changed: true, note: "Could not read the page before the click, so no effect can be reported." };
  return { changed: false, note: `⚠ No page change observed within ${waitMs}ms. The click was delivered, but nothing reacted yet; check with wait_for_change, or assert_clickable if it should have.` };
}

/** Shared reply for a click through clickWithFallback. A blocked click that also
 *  changed nothing failed, whatever the synthetic events returned. */
export async function clickReply(page: Page, label: string, click: () => Promise<ClickResult>, waitMs = 1000) {
  let result: ClickResult = { mode: "real" };
  const outcome = await observeClick(page, async () => { result = await click(); }, waitMs);
  const failed = result.mode === "fallback" && !outcome.changed;
  return {
    content: [{ type: "text" as const, text: `${label}. URL: ${page.isClosed() ? "(tab closed)" : page.url()}${clickNote(result)}\n${outcome.note}` }],
    ...(failed ? { isError: true } : {}),
  };
}

// Fill that really REPLACES the existing value.
// Playwright's fill() types into "text-like" inputs after a select-all. In
// Camoufox/Firefox that select-all is a no-op on input[type=email] and
// input[type=number] (Firefox restricts the selection APIs on those types), so a
// fill over a non-empty field APPENDS — e.g. re-filling an email field yields
// "old@x.comnew@x.com". Clearing first makes fill deterministic for every type.
//
// A fill that then fails must leave the field as it found it: clearing a disabled or
// readonly field and reporting an error destroyed its value. The typed value is also
// cut from any error, which may quote it.
export async function fillLocator(loc: any, value: string): Promise<void> {
  const prior: string | null = await loc.evaluate((el: any) => {
    if (!el || typeof el.value !== "string" || el.value === "") return null;
    if (el.matches?.(":disabled") || el.readOnly || el.type === "checkbox" || el.type === "radio") return null;
    const old = el.value;
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return old;
  }, undefined, { timeout: ACTION_TIMEOUT });
  try {
    await loc.fill(value, { timeout: ACTION_TIMEOUT });
  } catch (err: any) {
    if (prior !== null) {
      await loc.evaluate((el: any, old: string) => {
        el.value = old;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, prior, { timeout: ACTION_TIMEOUT }).catch(() => {});
    }
    const msg = String(err?.message || err);
    throw new Error(value ? msg.split(value).join("***") : msg);
  }
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
      const ty = String(el.type || "").toLowerCase();
      const hint = `${el.name || ""} ${el.id || ""} ${el.getAttribute("autocomplete") || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase();
      const secret = ty === "password" || /pass|secret|token|otp|cvv|card|pin/.test(hint);
      return {
        ref, index: idx,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        text: (el.innerText || (secret ? "" : el.value) || "").trim().slice(0, 60),
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

// Main-frame navigations per page, counted from framenavigated. The lifecycle events
// are unusable here, and readyState alone cannot tell "already loaded" from "just
// navigated", so the waits and click reports read this.
const navByPage = new WeakMap<Page, { seq: number; at: number }>();
export function navSeqOf(p: Page): number { return navByPage.get(p)?.seq ?? 0; }
export function lastNavAt(p: Page): number { return navByPage.get(p)?.at ?? 0; }

/** Substring match, or glob-ish when the pattern contains `*`. */
export function urlMatches(url: string, pattern: string): boolean {
  if (!pattern) return false;
  if (!pattern.includes("*")) return url.includes(pattern);
  const rx = new RegExp("^" + pattern.split("*").map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
  return rx.test(url);
}

/** Wait for the page URL by polling it. page.waitForURL waits for the load event by
 *  default, which Camoufox stops delivering after the fifth page in a context. */
export async function waitForUrl(page: Page, matches: (url: string) => boolean, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (matches(page.url())) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(50);
  }
}

/** Move or click the mouse without touching the top edge. Once the pointer has been
 *  inside the page, a move to y in [0, 1) is never answered by Juggler (Playwright floors
 *  the coordinate to 0; y=1 and y=-5 are both fine), and every later mouse call on that
 *  tab waits behind it. A stepped move crossing the edge lands on 0 only sometimes, which
 *  made this look like a random wedge. Nothing above y=1 is worth aiming at, so the
 *  target is held at y>=1 and a straight path from there never crosses the edge. */
export function safePointY(y: number): number { return y < 1 ? 1 : y; }
export async function pointerMove(page: Page, x: number, y: number, opts?: { steps?: number }): Promise<void> {
  await page.mouse.move(x, safePointY(y), opts);
}
export async function pointerClick(page: Page, x: number, y: number, opts?: { button?: "left" | "right" | "middle" }): Promise<void> {
  await page.mouse.click(x, safePointY(y), opts);
}

/** The viewport the page really has. page.viewportSize() is null under no_viewport. */
export async function viewportOf(page: Page): Promise<{ width: number; height: number }> {
  const fixed = page.viewportSize();
  if (fixed) return fixed;
  const raw = await page.evaluate(`(function () { return JSON.stringify({ width: innerWidth, height: innerHeight }); })()`) as string;
  return JSON.parse(raw);
}

/** Refuse a coordinate click on an element when something else would take it. A
 *  trial click runs Playwright's own hit test at that exact point without firing. */
export async function hitTestAt(loc: any, position?: { x: number; y: number }): Promise<string | null> {
  try {
    await loc.click({ trial: true, timeout: ACTION_TIMEOUT, ...(position ? { position } : {}) });
    return null;
  } catch (err: any) {
    const msg = String(err?.message || err);
    const blocker = interceptorIn(msg);
    if (blocker) return `Not clicked: ${blocker} covers that point and would take the click.`;
    if (await loc.count().catch(() => 0) === 0) return "Not clicked: element not found. The ref may be from an older snapshot: call browser_snapshot again.";
    return `Not clicked: the element cannot be clicked there. ${scrubErrorText(msg).split("\n")[0].slice(0, 160)}`;
  }
}

/** Go back or forward and report whether the page moved. page.goBack answers null when
 *  there is nothing to go to, and also for a same-document (pushState) entry, so null
 *  alone does not mean "stayed put". history.length proves nothing here: Camoufox
 *  randomises it. browser_launch has to enable session history for this to work. */
export async function historyStep(page: Page, direction: "back" | "forward", timeout = 15000): Promise<{ moved: boolean; url: string }> {
  const seq = navSeqOf(page), urlBefore = page.url();
  const opts = { waitUntil: "commit" as const, timeout };
  const res = direction === "back" ? await page.goBack(opts) : await page.goForward(opts);
  const changed = () => res !== null || navSeqOf(page) !== seq || page.url() !== urlBefore;
  if (!changed()) await page.waitForTimeout(150);
  if (!changed()) return { moved: false, url: page.url() };
  await waitReady(page, "domcontentloaded", timeout);
  return { moved: true, url: page.url() };
}

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
  // Poll by hand rather than with page.waitForFunction: Playwright's polling
  // predicate runs through eval(), which a site with a strict script-src CSP
  // blocks outright ("call to eval() blocked by CSP" on the very first real site
  // this was tried on). page.evaluate of a plain expression is not affected.
  const want = waitUntil === "load" ? ["complete"] : ["interactive", "complete"];
  let state = "";
  for (;;) {
    // Mid-navigation the execution context is torn down; that is not a failure,
    // it just means the answer is not available yet.
    try { state = String(await page.evaluate(`document.readyState`)); } catch { state = ""; }
    if (want.indexOf(state) >= 0) break;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeout}ms waiting for the document to reach "${want[0]}" (last readyState: ${state || "unavailable"}). The page may still be loading — retry, or pass a larger timeout.`);
    }
    await page.waitForTimeout(50);
  }
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

/** Let a just-loaded page settle, but stop as soon as it actually has.
 *
 *  Every navigation used to be followed by a blind `waitForTimeout(1000)` (1500
 *  in launch and navigate_and_snapshot) — a guess made back when nothing here
 *  could tell when a page was ready. Measured on a local fixture, that guess was
 *  85% of navigate's total time: 1113ms, against 166ms for tab_new doing the same
 *  work without it. This waits for the same per-page in-flight counter the rest of
 *  the server uses and returns the moment the page is quiet, keeping the old
 *  duration only as the worst case for a page that really is still busy. */
export async function settle(page: Page, capMs: number, quietMs = 200): Promise<void> {
  const deadline = Date.now() + capMs;
  let quietSince = inflightOf(page) === 0 ? Date.now() : 0;
  while (Date.now() < deadline) {
    if (inflightOf(page) === 0) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= quietMs) return;
    } else quietSince = 0;
    await page.waitForTimeout(25);
  }
}

/** goto + waitReady. Every navigation in this server goes through here. */
export async function gotoReady(
  page: Page, url: string, waitUntil: WaitUntil = "domcontentloaded", timeout = 30000,
): Promise<void> {
  // Roughly one navigation in thirty, Camoufox never settles the commit promise
  // even though the navigation itself went through. Give commit the full budget
  // — a second goto issued while the first is still in flight makes BOTH fail,
  // which is how a bounded-retry version broke every CSP navigation — and on a
  // timeout ask the document whether it actually arrived.
  const started = Date.now();
  try {
    await page.goto(url, { waitUntil: "commit", timeout });
  } catch (err) {
    // Only a timeout can be an unsettled promise. A refused connection, blocked
    // port or DNS failure must surface: Firefox leaves location.href on the
    // requested URL while showing about:neterror, so page.url() alone would
    // report those as successful navigations.
    const msg = String((err as any)?.message || err);
    if (!/Timeout\s+\d+ms exceeded/i.test(msg)) throw err;
    let arrived = false;
    try {
      // Bounded: on a tab that never committed this evaluate can hang for ever, and
      // then the navigation never reports its own timeout.
      const raw = await Promise.race([
        page.evaluate(`(() => JSON.stringify({ href: location.href, doc: document.documentURI, state: document.readyState }))()`) as Promise<string>,
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error("page did not answer")), 3000)),
      ]);
      const g = JSON.parse(raw);
      arrived = sameNavTarget(g.href, url)
        && !/^about:(neterror|certerror|blocked|httpsonlyerror)/.test(String(g.doc || ""))
        && g.state !== "loading";
    } catch {}
    if (!arrived) throw err;
  }
  await waitReady(page, waitUntil, Math.max(3000, timeout - (Date.now() - started)));
}

/** Did we land on what we asked for? Compares origin+path, so a redirect to the
 *  canonical form of the same page still counts as arrived. */
function sameNavTarget(landed: string, requested: string): boolean {
  try {
    const a = new URL(landed), b = new URL(requested);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch { return landed === requested; }
}

let dialogSeq = 0;
async function answerDialog(dialog: any): Promise<void> {
  const once = S.oneShotDialog;
  if (once) S.oneShotDialog = null;
  const policy = once || S.autoDialogCfg;
  const accept = policy?.action === "accept";
  dialogLog.push({
    seq: ++dialogSeq, at: Date.now(), type: dialog.type(), message: String(dialog.message()).slice(0, 200),
    answer: accept ? "accepted" : policy ? "dismissed" : "dismissed automatically (no handler armed)",
  });
  if (dialogLog.length > 50) dialogLog.shift();
  try {
    if (accept) await dialog.accept(policy?.promptText || undefined);
    else await dialog.dismiss();
  } catch {}
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
  // One listener per page, so a dialog on any tab, including one opened later, always
  // gets an answer. Any registered listener turns off Playwright's auto-dismiss, so
  // this must answer every dialog or that page stays blocked for ever.
  p.on("dialog", answerDialog);
  const nav = { seq: 0, at: 0 };
  navByPage.set(p, nav);
  p.on("framenavigated", f => { if (f === p.mainFrame()) { nav.seq++; nav.at = Date.now(); } });
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
  // A ref left on an element from an earlier snapshot would make the new number name
  // two elements, and refLocator's .first() could then pick the one now hidden.
  var stale = document.querySelectorAll('[data-mcp-ref]');
  for (var si = 0; si < stale.length; si++) stale[si].removeAttribute('data-mcp-ref');
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
