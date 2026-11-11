// Pure-ish helpers shared by the tool modules: refs, clicks, fills, snapshots,
// paths, TOTP. Only trackPage/inflight touch shared state.
import type { Frame, Page } from "playwright-core";
import { S, HOME_DIR, PROFILE_DIR, SCREENSHOT_DIR, dialogLog, type DialogEntry } from "./state.js";
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
/** Open shadow roots a snapshot reads per document, and how deep it follows them. A page
 *  built from thousands of components must not turn one snapshot into thousands of
 *  queries; past either limit the snapshot stops reading and says so. */
export const MAX_SHADOW_ROOTS = 1000;
export const MAX_SHADOW_DEPTH = 8;

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

/** Run JavaScript where the page's own scripts live.
 *
 *  Current Camoufox evaluates in an isolated world: the DOM is the same, but
 *  `window.someAppVariable` is undefined and a page function cannot be called. That is
 *  what makes this server's own reads (snapshot, click checks, signatures) invisible to
 *  a page that wraps `querySelector` or `getBoundingClientRect`, so they stay on plain
 *  `page.evaluate`. Only code the CALLER wrote goes through here, with Camoufox's `mw:`
 *  prefix. A page can observe what such code calls. */
export async function evalMain(target: { evaluate(expression: string): Promise<any> }, expression: string): Promise<any> {
  return target.evaluate(S.evalIsolated ? "mw:" + expression : expression);
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

/** Why Playwright's actionability checks kept failing, from its call log. */
function actionabilityReason(message: string): string {
  const all = scrubErrorText(message).match(/element is (?:not [a-z]+|outside of the viewport)/g);
  return all ? all[all.length - 1] : "the checks did not pass in time";
}

/** Did Playwright send the click before it gave up? Its call log says so. */
function clickDelivered(message: string): boolean {
  return /(?:click|dblclick) action done|waiting for scheduled navigations/.test(message);
}

/** How long the real click may wait before the element is looked at again. Playwright
 *  keeps retrying a covered or disabled element for the whole timeout and only then
 *  says why, which made every refused click cost five seconds. */
export const QUICK_CLICK_MS = 1500;

/** What stops a click, read in the isolated world so the page cannot see the question.
 *  With `frames`, an element inside an iframe the user cannot see is hidden too: from
 *  inside the frame it looks visible, and the fallback fired its handler. */
async function clickObstacle(loc: any, frames = false): Promise<{ disabled: boolean; hidden: boolean } | null> {
  try {
    const state = await loc.evaluate((el: any) => {
      const r = el.getBoundingClientRect();
      const cs = el.ownerDocument.defaultView.getComputedStyle(el);
      return {
        disabled: !!el.matches?.(":disabled") || el.getAttribute?.("aria-disabled") === "true",
        hidden: cs.display === "none" || cs.visibility === "hidden" || r.width < 1 || r.height < 1,
      };
    }, undefined, { timeout: 1000 });
    if (frames && !state.hidden) {
      const handle = await loc.elementHandle({ timeout: 1000 });
      const frame: Frame | null = handle ? await handle.ownerFrame() : null;
      await handle?.dispose().catch(() => {});
      if (frame && frame.parentFrame() && !(await frameShown(frame).catch(() => true))) state.hidden = true;
    }
    return state;
  } catch { return null; }
}

const NOT_FOUND = "Element not found. The ref may be from an older snapshot: call browser_snapshot again.";
const DISABLED = "Not clicked: the element is disabled, so a click would do nothing. Nothing was fired.";

export async function clickWithFallback(
  loc: any,
  opts?: { button?: "left" | "right" | "middle"; dblclick?: boolean },
): Promise<ClickResult> {
  const button = opts?.button || "left";
  const real = (timeout: number) => opts?.dblclick ? loc.dblclick({ button, timeout }) : loc.click({ button, timeout });
  // A ref that names nothing, or a control that is disabled, is known before the click.
  // Waiting out Playwright's timeout to learn it cost five seconds each time.
  if (await loc.count().catch(() => 0) === 0) throw new Error(NOT_FOUND);
  let before = await clickObstacle(loc);
  for (let i = 0; before?.disabled && i < 4; i++) {
    // A submit button often enables a moment after the last field is filled.
    await new Promise(r => setTimeout(r, 100));
    before = await clickObstacle(loc);
  }
  if (before?.disabled) throw new Error(DISABLED);

  let why = "";
  const started = Date.now();
  try {
    await real(QUICK_CLICK_MS);
    return { mode: "real" };
  } catch (err: any) {
    why = String(err?.message || err);
  }
  // Playwright counts the wait for a navigation the click started inside the click's own
  // timeout. A form whose server took two seconds timed out AFTER the click was sent, and
  // a retry sent the form again. A delivered click is never repeated; observeClick then
  // reports the navigation.
  if (clickDelivered(why)) return { mode: "real" };
  if (await loc.count().catch(() => 0) === 0) throw new Error(NOT_FOUND);
  let blocker = interceptorIn(why);
  let state = await clickObstacle(loc, true);
  if (!blocker && !state?.disabled && !state?.hidden) {
    // Not covered, not disabled, not hidden: it is still moving or still appearing, and
    // that is worth the rest of the usual patience.
    try {
      await real(Math.max(500, ACTION_TIMEOUT - (Date.now() - started)));
      return { mode: "real" };
    } catch (err: any) {
      why = String(err?.message || err);
      if (clickDelivered(why)) return { mode: "real" };
      if (await loc.count().catch(() => 0) === 0) throw new Error(NOT_FOUND);
      blocker = interceptorIn(why);
      state = await clickObstacle(loc, true);
    }
  }
  if (state?.disabled) throw new Error(DISABLED);
  if (state?.hidden) throw new Error("Not clicked: the element is hidden (display, visibility or zero size, or inside an iframe no user can see). Nothing was fired. Take a new browser_snapshot, or click the visible control that stands for it.");
  if (button !== "left" || opts?.dblclick) {
    throw new Error(`Not clicked: the real ${opts?.dblclick ? "double " : ""}${button} click was blocked${blocker ? ` by ${blocker}` : ""}, and no synthetic fallback exists for it. Nothing was fired.`);
  }
  // The fallback is for an element something covers. One that nothing covers and that a
  // real click still cannot reach (parked at left:-9999px, never stable) is somewhere no
  // user could click, which is what a honeypot link looks like.
  if (!blocker) {
    throw new Error(`Not clicked: the real click could not reach the element (${actionabilityReason(why)}), and nothing covers it, so a synthetic click would land where no user could. Nothing was fired. Scroll it into view, or take a new browser_snapshot.`);
  }
  await loc.evaluate((el: any) => {
    const r = el.getBoundingClientRect();
    // The element's own window, not the global `window`: in Camoufox's isolated world
    // the global is not a Window, and every event constructor refused it as `view`.
    // That made this whole fallback throw instead of click.
    const view = el.ownerDocument.defaultView;
    const base: any = {
      bubbles: true, cancelable: true, composed: true, view,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true,
    };
    const PE = view.PointerEvent || view.MouseEvent;
    const ME = view.MouseEvent;
    el.dispatchEvent(new PE("pointerover", { ...base, buttons: 0 }));
    el.dispatchEvent(new ME("mouseover", { ...base, buttons: 0 }));
    el.dispatchEvent(new PE("pointerdown", { ...base, buttons: 1 }));
    el.dispatchEvent(new ME("mousedown", { ...base, buttons: 1 }));
    if (typeof el.focus === "function") { try { el.focus(); } catch {} }
    el.dispatchEvent(new PE("pointerup", { ...base, buttons: 0 }));
    el.dispatchEvent(new ME("mouseup", { ...base, buttons: 0 }));
    // el.click() (not a synthetic click event) so default actions — anchor
    // navigation, form submit, label activation — still happen.
    if (typeof el.click === "function") el.click();
  }, undefined, { timeout: ACTION_TIMEOUT });
  return { mode: "fallback", blocker };
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
// Playwright scrolls a target into view before clicking it. outerHTML leaves out what
// is inside a shadow root, so a web component that changed its own content read as a
// dead click; open shadow roots are hashed too, within the snapshot's limits. Finding
// them means touching every element (2.5ms on a 5,800-element page, against 0.45ms for
// outerHTML), so the reading before a click looks for them and the readings after it
// reuse that list. A host the click adds changes its parent's HTML, which is hashed.
const SIG_HOSTS_KEY_JS = `Symbol.for("mcp.camoufox.sighosts")`;
function pageSignatureJs(rescan: boolean): string {
  return `(function () {
  var h = 2166136261, K = ${SIG_HOSTS_KEY_JS};
  function add(t) { for (var i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } }
  function fields(root) {
    var f = root.querySelectorAll("input, textarea, select");
    for (var j = 0; j < f.length; j++) add(String(f[j].value) + (f[j].checked ? "1" : "0"));
  }
  var hosts = ${rescan ? "null" : "globalThis[K]"};
  if (!hosts) {
    hosts = [];
    (function scan(root, depth) {
      if (depth >= ${MAX_SHADOW_DEPTH}) return;
      var all = root.querySelectorAll("*");
      for (var k = 0; k < all.length && hosts.length < ${MAX_SHADOW_ROOTS}; k++) {
        if (all[k].shadowRoot) { hosts.push(new WeakRef(all[k])); scan(all[k].shadowRoot, depth + 1); }
      }
    })(document, 0);
    globalThis[K] = hosts;
  }
  add(document.documentElement ? document.documentElement.outerHTML : "");
  fields(document);
  for (var n = 0; n < hosts.length; n++) {
    var el = hosts[n].deref(), sr = el && el.isConnected && el.shadowRoot;
    add("#shadow" + n);
    if (sr) { add(sr.innerHTML); fields(sr); }
  }
  return document.title + "|" + (h >>> 0);
})()`;
}
const PAGE_SIGNATURE_SCAN_JS = pageSignatureJs(true);
const PAGE_SIGNATURE_JS = pageSignatureJs(false);

/** Which world page.evaluate runs in on this build: true for Camoufox's isolated world
 *  (only it has wrappedJSObject), false for the page's own, null when the question could
 *  not be asked. Reading a failure as "page's own" sent evaluate there without the mw:
 *  prefix, and every page variable read as undefined with no warning. */
export async function detectEvalWorld(page: { evaluate(expression: string): Promise<any> }): Promise<boolean | null> {
  try { return (await page.evaluate(`typeof window.wrappedJSObject`)) === "object"; } catch { return null; }
}

/** A promise that rejects after ms. */
const within = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

/** What a click can change, read part by part: the main document, and the frame the
 *  clicked element lives in. Each part has its own deadline, and one that could not be
 *  read is unknown (null) rather than spoiling the rest. Only the clicked element's frame
 *  is read: hashing every frame the last snapshot listed made an iframe that changes on
 *  its own (a playing video, a rotating ad) turn every dead click into "Page content
 *  changed", and a failed fallback into a success. */
async function pageSignature(page: Page, frame?: Frame, rescan = false): Promise<(string | null)[]> {
  const read = (target: Page | Frame) =>
    within(target.evaluate(rescan ? PAGE_SIGNATURE_SCAN_JS : PAGE_SIGNATURE_JS) as Promise<string>, 1500).catch(() => null);
  return Promise.all([read(page), ...(frame && !frame.isDetached() ? [read(frame)] : [])]);
}
/** A part both readings know and that differs. */
function signatureChanged(a: (string | null)[], b: (string | null)[]): boolean {
  return a.some((part, i) => part !== null && b[i] != null && part !== b[i]);
}

/** The frame a snapshot ref lives in, or undefined for the main document. */
export function frameOfRef(page: Page, ref?: string): Frame | undefined {
  const m = /^(f\d+)e\d+$/.exec(String(ref || "").replace(/^ref:/, "").replace(/[^\w-]/g, ""));
  return m ? frameRefs.get(page)?.get(m[1]) : undefined;
}

export interface ClickOutcome { changed: boolean; note: string; }

/** How long a finished navigation request is given to report its commit. */
const COMMIT_GRACE_MS = 250;
/** How long a click that opened a dialog is still watched for a navigation. */
const DIALOG_FOLLOW_MS = 300;

/** "an alert", "a confirm". */
export function aOrAn(word: string): string { return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`; }

/** Run a click and report what the page did. Waits up to waitMs but returns as soon
 *  as something reacted. A new tab changes nothing on its own page, so tabs are watched
 *  too, or a working popup button reads as dead and an agent clicks it again. */
export async function observeClick(page: Page, click: () => Promise<void>, waitMs = 1000, ref?: string): Promise<ClickOutcome> {
  const ctx = page.context();
  const pagesBefore = new Set(ctx.pages());
  const urlBefore = page.url();
  const seqBefore = navSeqOf(page);
  const navReqBefore = navRequestsOf(page).seq;
  const dialogsBefore = dialogLog.at(-1)?.seq ?? 0;
  const frame = frameOfRef(page, ref);
  const sigBefore = await pageSignature(page, frame, true);
  await click();
  const clickedAt = Date.now();
  let deadline = clickedAt + waitMs;
  let waitedForServer = false;
  let graceUntil = 0;
  let dialog: DialogEntry | undefined;
  let lastSig = sigBefore;
  const opened = () => ctx.pages().filter(p => !pagesBefore.has(p));
  // Look early, then settle into the usual pace: most handlers have run within a few
  // milliseconds, and a fixed 50ms first look was most of a fast click's time.
  for (let look = 0; ; look++) {
    await page.waitForTimeout(look === 0 ? 10 : look === 1 ? 25 : 50).catch(() => {});
    if (page.isClosed()) return { changed: true, note: "The tab closed itself." };
    const navigated = page.url() !== urlBefore || navSeqOf(page) !== seqBefore;
    if (opened().length) {
      const fresh = opened()[0];
      // A popup starts on about:blank and gets its address a moment later.
      for (let i = 0; i < 20 && fresh.url() === "about:blank"; i++) await page.waitForTimeout(50).catch(() => {});
      return { changed: true, note: `Opened a new tab [${S.pages.indexOf(fresh)}]: ${fresh.url()}. The active tab did not change; use tab_select to switch.` };
    }
    const said = dialog ? `The click opened ${aOrAn(dialog.type)} dialog, which was ${dialog.answer}. ` : "";
    if (navigated) return { changed: true, note: `${said}${said ? "Then the page" : "Page"} navigated to ${page.url()}.` };
    // A dialog is the page reacting. It used to be reported as "No page change observed"
    // after the full wait, right above the note that a dialog had appeared. Only this
    // tab's dialogs count: one from another tab is named by the call's own note. The page
    // is still watched for a moment after it, because an accepted confirm usually leads
    // somewhere and that navigation belongs in the same report.
    if (!dialog) {
      dialog = dialogLog.find(d => d.seq > dialogsBefore && d.page === page);
      if (dialog) deadline = Math.min(deadline, Date.now() + DIALOG_FOLLOW_MS);
    }
    lastSig = await pageSignature(page, frame);
    const nav = navRequestsOf(page);
    const started = nav.seq !== navReqBefore;
    if (!dialog && signatureChanged(lastSig, sigBefore)) {
      // The new document can be read a few milliseconds before Camoufox reports the
      // commit. When the click started a navigation, that is what changed the content,
      // so wait out the grace for it rather than report a navigation as "content
      // changed" one time in thirty.
      if (started) {
        const moved = () => page.url() !== urlBefore || navSeqOf(page) !== seqBefore;
        for (const until = Date.now() + COMMIT_GRACE_MS; !moved() && Date.now() < until;) await page.waitForTimeout(10).catch(() => {});
        if (moved()) return { changed: true, note: `Page navigated to ${page.url()}.` };
      }
      return { changed: true, note: "Page content changed." };
    }
    // A navigation the click started that is still waiting for the server gets the
    // usual action timeout to commit.
    const pending = started && nav.open.size > 0;
    // Camoufox reports the commit a few milliseconds AFTER the request finished, so a
    // finished request gets a short grace instead of ending the wait at once, in either
    // phase. A request that finished without a commit (a 204, a download) then reads as
    // no change.
    if (started && !pending) {
      if (!graceUntil) graceUntil = Date.now() + COMMIT_GRACE_MS;
      deadline = waitedForServer ? Math.min(deadline, graceUntil) : Math.max(deadline, graceUntil);
    }
    if (Date.now() >= deadline) {
      if (pending && waitedForServer) {
        return { changed: true, note: `${said}The click started a navigation to ${nav.url}, and the server had not answered within ${Math.round((Date.now() - clickedAt) / 1000)}s. Do not click again: follow it with wait_for_navigation or wait_for_url.` };
      }
      if (!pending) break;
      waitedForServer = true;
      deadline = Date.now() + ACTION_TIMEOUT;
    }
  }
  if (dialog) {
    const also = signatureChanged(lastSig, sigBefore) ? " Page content changed after it." : "";
    return { changed: true, note: `The click opened ${aOrAn(dialog.type)} dialog, which was ${dialog.answer}.${also}` };
  }
  // The part the click targets: its frame when it has one, else the main document.
  if (sigBefore[sigBefore.length - 1] === null) return { changed: true, note: "Could not read the page before the click, so no effect can be reported." };
  return { changed: false, note: `⚠ No page change observed within ${waitMs}ms. The click was delivered, but nothing reacted yet; check with wait_for_change, or assert_clickable if it should have.` };
}

/** Shared reply for a click through clickWithFallback. A blocked click that also
 *  changed nothing failed, whatever the synthetic events returned. */
export async function clickReply(page: Page, label: string, click: () => Promise<ClickResult>, waitMs = 1000, ref?: string) {
  let result: ClickResult = { mode: "real" };
  const outcome = await observeClick(page, async () => { result = await click(); }, waitMs, ref);
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
  // A ref that names nothing is known now. Waiting for it to appear took five seconds
  // and then answered "Timeout", which says nothing about what to do next.
  if (await loc.count().catch(() => 1) === 0) throw new Error(NOT_FOUND);
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

// ── Refs ─────────────────────────────────────────────────────────────────────
// A ref names an element through a registry kept in the page's ISOLATED world, not
// through a DOM attribute. Refs used to be written as data-mcp-ref attributes: sixteen
// attribute mutations per snapshot on a small page, visible to any MutationObserver,
// and `document.querySelector("[data-mcp-ref]")` told a site outright that this server
// was driving it. Nothing is written to the document now. A custom selector engine
// resolves `mcpref=e5` from the registry, so every Locator call keeps working.

/** Key of the registry on the isolated global. On an old Camoufox that evaluates in the
 *  page's own world (S.evalIsolated false) this hides nothing: Symbol.for is a global
 *  registry, so the page can read window[Symbol.for("mcp.camoufox.refs")], or swap the
 *  Map and point refs at other elements. Only the isolated world keeps it out of reach. */
const REF_KEY_JS = `Symbol.for("mcp.camoufox.refs")`;

/** `function (el, ref)`: register an element under a ref. For splicing into evaluate strings. */
export const REF_PUT_FN = `function (el, ref) {
  var k = ${REF_KEY_JS};
  var m = globalThis[k] || (globalThis[k] = new Map());
  m.set(ref, new WeakRef(el));
  return ref;
}`;

/** `function (ref)`: the element a ref names, or null. A data-mcp-ref attribute is still
 *  honoured, for a page or a test that sets one itself; the server never writes it. */
export const REF_GET_FN = `function (ref) {
  var m = globalThis[${REF_KEY_JS}];
  var w = m && m.get(ref);
  var el = w && w.deref();
  if (el && el.isConnected) return el;
  try { return document.querySelector('[data-mcp-ref="' + String(ref).replace(/[^\\w-]/g, "") + '"]'); } catch (e) { return null; }
}`;

const REF_ENGINE_JS = `(() => {
  var get = ${REF_GET_FN};
  return {
    query: function (root, ref) {
      var el = get(ref);
      if (!el) return null;
      return root === el || !root.contains || root.contains(el) || root.nodeType === 9 ? el : null;
    },
    queryAll: function (root, ref) { var el = this.query(root, ref); return el ? [el] : []; },
  };
})()`;

/** Resolves once the `mcpref=` engine exists. It has to be registered before the
 *  browser context is created, so browser_launch awaits this. playwright-core is loaded
 *  here and not at startup: importing it took about 90ms of every server's initialize,
 *  including servers that only ever use the browserless HTTP tools. */
let refEngine: Promise<void> | null = null;
export function refEngineReady(): Promise<void> {
  if (!refEngine) {
    refEngine = import("playwright-core").then(({ selectors }) => selectors.register("mcpref", REF_ENGINE_JS)).catch((e: any) => {
      // A second registration in one process (two copies of this module) is not an error.
      if (/already registered|has been already/i.test(String(e?.message || e))) return;
      refEngine = null;   // let the next launch try again and report its own error
      throw e;
    });
  }
  return refEngine;
}

// Frames a snapshot gave refs to, by prefix ("f1"). A ref like f1e3 lives in that
// frame's own registry, so it has to be looked up there.
const frameRefs = new WeakMap<Page, Map<string, Frame>>();

// Locator for a snapshot ref. The only place the ref scheme is turned into a selector.
export function refLocator(page: Page, ref: string) {
  const clean = String(ref || "").replace(/[^\w-]/g, "") || "none";
  const inFrame = /^(f\d+)e\d+$/.exec(clean);
  if (inFrame) {
    const frame = frameRefs.get(page)?.get(inFrame[1]);
    if (frame && !frame.isDetached()) return frame.locator(`mcpref=${clean}`).first();
  }
  return page.locator(`mcpref=${clean}`).first();
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
      // Same registry browser_snapshot fills (REF_PUT_FN), inlined: this function is
      // serialised on its own and cannot see module scope.
      const g: any = globalThis, key = Symbol.for("mcp.camoufox.refs");
      (g[key] || (g[key] = new Map())).set(ref, new WeakRef(el));
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

// Main-frame navigation requests per page: how many have started, and which are still
// waiting for the server. A click that submitted a form to a slow server has changed
// nothing yet, and "No page change observed" would send an agent to click it again.
const navRequestsByPage = new WeakMap<Page, { seq: number; url: string; open: Set<any> }>();
function navRequestsOf(p: Page) { return navRequestsByPage.get(p) || { seq: 0, url: "", open: new Set<any>() }; }
function isMainNavigation(p: Page, req: any): boolean {
  try { return req.isNavigationRequest() && req.frame() === p.mainFrame(); } catch { return false; }
}

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
  let polls = 0;
  for (;;) {
    // Mid-navigation the execution context is torn down; that is not a failure,
    // it just means the answer is not available yet.
    try { state = String(await page.evaluate(`document.readyState`)); } catch { state = ""; }
    if (want.indexOf(state) >= 0) break;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeout}ms waiting for the document to reach "${want[0]}" (last readyState: ${state || "unavailable"}). The page may still be loading — retry, or pass a larger timeout.`);
    }
    // Short steps at first: a local or cached page is ready within a few milliseconds
    // of the commit, and a flat 50ms step was a fifth of such a navigation.
    await page.waitForTimeout(++polls <= 10 ? 10 : 50);
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
  let complete = false;
  while (Date.now() < deadline) {
    if (inflightOf(page) === 0) {
      if (!quietSince) quietSince = Date.now();
      // A document that has fired load with nothing in flight has nothing left to wait
      // for, so it gets one short look for a request started from a load handler. The
      // full quiet window is for a page that is still loading, where the next request
      // may not have left yet. Waiting it out on every page was 200ms of each navigate.
      if (!complete) {
        try { complete = (await page.evaluate(`document.readyState`)) === "complete"; } catch {}
      }
      if (Date.now() - quietSince >= (complete ? SETTLED_QUIET_MS : quietMs)) return;
    } else quietSince = 0;
    await page.waitForTimeout(complete ? 10 : 25);
  }
}
/** Quiet time asked of a page that has already fired load. */
export const SETTLED_QUIET_MS = 30;

/** goto + waitReady. Every navigation in this server goes through here. */
/** What a person means by a bare address. "example.com" failed with Playwright's
 *  "Invalid url" after a launch that otherwise worked, the first thing a new user tried.
 *  A host gets https://, localhost and an IP address http://. Anything with a scheme,
 *  about:, data: and the like is left alone. */
export function normalizeUrl(raw: string): string {
  const url = String(raw ?? "").trim();
  if (!url) return url;
  const host = url.match(/^([^/?#]+)/)?.[1] || "";
  const local = /^(localhost|127(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|(?:\d{1,3}\.){3}\d{1,3})(:\d+)?$/i.test(host);
  if (local) return "http://" + url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(host)) return "https://" + url;
  return url;
}

export async function gotoReady(
  page: Page, rawUrl: string, waitUntil: WaitUntil = "domcontentloaded", timeout = 30000,
): Promise<void> {
  const url = normalizeUrl(rawUrl);
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
  let page: unknown = null;
  try { page = dialog.page(); } catch {}
  dialogLog.push({
    seq: ++dialogSeq, at: Date.now(), type: dialog.type(), message: String(dialog.message()).slice(0, 200), page,
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
  const navReq = { seq: 0, url: "", open: new Set<any>() };
  navRequestsByPage.set(p, navReq);
  p.on("request", req => {
    inflight.n++;
    if (isMainNavigation(p, req)) { navReq.seq++; navReq.url = req.url(); navReq.open.add(req); }
  });
  p.on("requestfinished", req => { if (inflight.n > 0) inflight.n--; navReq.open.delete(req); });
  p.on("requestfailed", req => { if (inflight.n > 0) inflight.n--; navReq.open.delete(req); });
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

// DOM snapshot JS — IIFE so page.evaluate runs it immediately. It only READS the
// document: refs go into the isolated-world registry (see "Refs" above).
//
// A form field carries the text of its label (`<label for>`, a wrapping label, or
// aria-labelledby), and that label's own row is dropped when the field has one. A field
// used to print as a bare `[input]` with its name on the row above, so it could not be
// found by name and a form took twice the rows.
//
// Open shadow roots are read too, with the same selector, and their elements are listed
// right after the element that hosts them. Web components (Shoelace, Lit, Salesforce,
// many design systems) keep every control there, and a snapshot that stopped at the host
// had nothing to click. A closed shadow root cannot be read from a page and is not forced.
export function snapshotJs(prefix = ""): string {
  return `(() => {
  var PREFIX = ${jsStr(prefix)};
  var isSecret = ${SECRET_FIELD_FN};
  var sels = 'button, a, input:not([type="hidden"]), textarea, select, '
    + '[role="button"], [role="link"], [role="textbox"], [role="checkbox"], '
    + '[role="radio"], [role="tab"], [role="menuitem"], [contenteditable="true"], '
    + 'img[alt], h1, h2, h3, h4, h5, h6, label, [role="dialog"], [role="alert"], [role="status"]';
  // A fresh registry each time: a ref from an earlier snapshot must not name anything.
  var refs = globalThis[${REF_KEY_JS}] = new Map();
  var win = document.defaultView;
  var shadow = { roots: 0, tooDeep: 0, tooMany: 0 };
  // The selector's matches in a root, with each open shadow root's matches spliced in
  // after its host, in document order. A page of thousands of components stops at a
  // limit, and the snapshot says so.
  function gather(root, depth) {
    var found = root.querySelectorAll(sels), hosts = [], all = root.querySelectorAll('*');
    for (var a = 0; a < all.length; a++) if (all[a].shadowRoot) hosts.push(all[a]);
    if (!hosts.length) return Array.prototype.slice.call(found);
    var out = [], h = 0;
    function inner(host) {
      if (depth >= ${MAX_SHADOW_DEPTH}) { shadow.tooDeep++; return; }
      if (shadow.roots >= ${MAX_SHADOW_ROOTS}) { shadow.tooMany++; return; }
      shadow.roots++;
      var got = gather(host.shadowRoot, depth + 1);
      for (var g = 0; g < got.length; g++) out.push(got[g]);
    }
    for (var m = 0; m < found.length; m++) {
      // Hosts before this element go first. A host that is itself listed comes before
      // its own shadow content.
      var self = false;
      while (h < hosts.length && (hosts[h] === found[m] || (hosts[h].compareDocumentPosition(found[m]) & 4))) {
        if (hosts[h] === found[m]) { out.push(found[m]); self = true; }
        inner(hosts[h++]);
      }
      if (!self) out.push(found[m]);
    }
    while (h < hosts.length) inner(hosts[h++]);
    return out;
  }
  var els = gather(document, 0);
  var visible = [];
  for (var i = 0; i < els.length; i++) {
    var r = els[i].getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    var cs = win.getComputedStyle(els[i]);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    visible.push(els[i]);
  }
  var shown = new Set(visible);
  function clean(t) { return String(t || '').replace(/\\s+/g, ' ').trim(); }
  // A wrapping label's text without the text of the field it wraps (a select's options).
  function labelText(label, field) {
    if (!label.contains(field)) return clean(label.innerText || label.textContent);
    var out = '', walker = document.createTreeWalker(label, 4);
    for (var n = walker.nextNode(); n; n = walker.nextNode()) if (!field.contains(n)) out += ' ' + n.nodeValue;
    return clean(out);
  }
  // A control a label stands in for: listed, but drawn as nothing a user can see.
  function standIn(f) {
    var r = f.getBoundingClientRect(), cs = win.getComputedStyle(f);
    return r.width <= 1 || r.height <= 1 || Number(cs.opacity) === 0
      || (cs.clip && cs.clip !== 'auto') || (cs.clipPath && cs.clipPath !== 'none');
  }
  var labelOf = new Map(), used = new Set();
  for (var v = 0; v < visible.length; v++) {
    var f = visible[v], tag = f.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') continue;
    var parts = [];
    var by = f.getAttribute('aria-labelledby');
    // Looked up in the field's own root: an id inside a shadow root is not the document's.
    var home = f.getRootNode();
    if (by) by.split(/\\s+/).forEach(function (id) { var t = id && home.getElementById && home.getElementById(id); if (t) parts.push(clean(t.innerText || t.textContent)); });
    var ls = f.labels;
    for (var k = 0; ls && k < ls.length; k++) {
      if (!parts.length || !by) parts.push(labelText(ls[k], f));
      // The label's row goes only when the field itself is listed and a user can see it.
      // A label standing in for a hidden checkbox is the thing to click, so it keeps its
      // row; so does one for an sr-only (1x1, clipped) or transparent control, which the
      // size filter lets through but no real click reaches.
      if (shown.has(ls[k]) && !standIn(f)) used.add(ls[k]);
    }
    var name = clean(parts.join(' ')).slice(0, 80);
    if (name) labelOf.set(f, name);
  }
  var results = [];
  var refId = 0;
  for (var i = 0; i < visible.length; i++) {
    var el = visible[i];
    if (used.has(el)) continue;
    var ref = PREFIX + 'e' + refId++;
    refs.set(ref, new WeakRef(el));
    var ty = (el.type || '').toLowerCase();
    var entry = {
      ref: ref,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      text: (function () {
        // A secret-looking field shows neither its value nor its chosen option (a card's
        // expiry month is a select), by the one definition every tool uses.
        if (el.tagName === 'SELECT') {
          var o = el.selectedOptions && el.selectedOptions[0], ot = o ? clean(o.text) : '';
          return !ot ? '' : isSecret(el) ? '••• ' + ot.length + ' chars (masked)' : ot.slice(0, 100);
        }
        // A checkbox's value is the word "on" unless the page set one. It says nothing.
        if (ty === 'checkbox' || ty === 'radio') return '';
        var t = el.innerText || '';
        if (t) return t.trim().slice(0, 100);
        var v = el.value || '';
        if (!v) return '';
        // A password/secret field's VALUE must never leave the browser: masking
        // it only in fill() was pointless while every snapshot printed it.
        if (isSecret(el)) return '••• ' + v.length + ' chars (masked)';
        return v.trim().slice(0, 100);
      })(),
      type: el.getAttribute('type') || '',
      label: labelOf.get(el) || '',
      name: el.getAttribute('name') || '',
      placeholder: el.getAttribute('placeholder') || '',
      aria: el.getAttribute('aria-label') || '',
      href: el.tagName === 'A' ? (el.href || '').slice(0, 500) : '',
      checked: el.checked || false,
      disabled: el.disabled || false,
    };
    var out = {};
    var keys = Object.keys(entry);
    for (var j = 0; j < keys.length; j++) {
      var key = keys[j], val = entry[key];
      if (val !== '' && val !== false && val !== undefined) out[key] = val;
    }
    results.push(out);
  }
  return { elements: results, shadow: shadow };
})()`;
}
export const SNAPSHOT_JS = snapshotJs();

export function formatSnapshot(
  elements: any[],
  url: string,
  title: string,
  opts?: { roles?: string[]; offset?: number; limit?: number; notes?: string[] },
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
  let inFrame = "";
  for (const el of filtered) {
    const parts = [`[${el.tag || "?"}]`];
    if (el.role) parts.push(`role=${el.role}`);
    if (el.type) parts.push(`type=${el.type}`);
    if (el.label) parts.push(`label="${el.label}"`);
    if (el.text) parts.push(`"${el.text.slice(0, 80)}"`);
    if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
    if (el.aria) parts.push(`aria="${el.aria}"`);
    if (el.href) parts.push(`href="${el.href.slice(0, 60)}"`);
    if (el.checked) parts.push("checked");
    if (el.disabled) parts.push("disabled");
    const line = `  ref=${el.ref}  ${parts.join(" ")}`;
    if (budget - line.length < 0) { truncatedBySize = true; break; }
    if (el.frame && el.frame !== inFrame) {
      const head = `\nIn frame ${el.frame} (${String(el.frameUrl || "").slice(0, 80)}), refs work like any other:`;
      lines.push(head);
      budget -= head.length + 1;
    }
    inFrame = el.frame || "";
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
  for (const note of opts?.notes || []) lines.push("", note);
  return lines.join("\n");
}

/** Frames a snapshot will read, and elements it takes from each. A page full of ad
 *  iframes must not turn one snapshot into fifty evaluations or a wall of ad links. */
export const MAX_SNAPSHOT_FRAMES = 8;
export const MAX_FRAME_ELEMENTS = 60;


/** Can a user see this iframe? Its own document says nothing about that: a frame under
 *  visibility:hidden, inside an opacity:0 wrapper or parked at top:-10000px has elements
 *  that all look visible from inside. So the element that holds it is asked, and the one
 *  holding that, up to the page. A frame smaller than 20x20 is a tracker, not a widget. */
export async function frameShown(frame: Frame): Promise<boolean> {
  for (let f: Frame | null = frame; f && f.parentFrame(); f = f.parentFrame()) {
    const owner = await within(f.frameElement(), 1000);
    const shown = await within(owner.evaluate((el: any) => {
      const win = el.ownerDocument.defaultView, r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) return false;
      if (win.getComputedStyle(el).visibility !== "visible") return false;
      for (let e = el; e; e = e.parentElement) {
        const cs = win.getComputedStyle(e);
        if (cs.display === "none" || Number(cs.opacity) === 0) return false;
      }
      const de = el.ownerDocument.documentElement;
      const x = r.left + win.scrollX, y = r.top + win.scrollY;
      return x + r.width > 0 && y + r.height > 0
        && x < Math.max(de.scrollWidth, win.innerWidth) && y < Math.max(de.scrollHeight, win.innerHeight);
    }), 1000);
    if (!shown) return false;
  }
  return true;
}

// Run the DOM snapshot and format it — the evaluate(SNAPSHOT_JS)+formatSnapshot
// pair used by browser_snapshot and every *_and_snapshot compound tool.
export async function snapshotPage(
  page: Page,
  opts?: { roles?: string[]; offset?: number; limit?: number; frames?: boolean },
): Promise<string> {
  const main: any = await page.evaluate(SNAPSHOT_JS);
  const elements: any[] = main?.elements || [];
  const unreadShadow = { tooDeep: main?.shadow?.tooDeep || 0, tooMany: main?.shadow?.tooMany || 0 };
  // Elements inside iframes get refs too, so a button in a payment or login frame can
  // be clicked like any other. Only a frame that is visibly on the page is read.
  const framesByPrefix = new Map<string, Frame>();
  frameRefs.set(page, framesByPrefix);
  const notes: string[] = [];
  if (opts?.frames !== false) {
    let looked = 0, skipped = 0, unread = 0;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame() || frame.isDetached()) continue;
      if (framesByPrefix.size >= MAX_SNAPSHOT_FRAMES || looked >= 30) { skipped++; continue; }
      looked++;
      try {
        if (!(await frameShown(frame))) continue;
        const prefix = `f${framesByPrefix.size + 1}`;
        const got: any = await within(frame.evaluate(snapshotJs(prefix)), 2000);
        const found: any[] = got?.elements || [];
        unreadShadow.tooDeep += got?.shadow?.tooDeep || 0;
        unreadShadow.tooMany += got?.shadow?.tooMany || 0;
        if (!found.length) continue;
        framesByPrefix.set(prefix, frame);
        for (const el of found.slice(0, MAX_FRAME_ELEMENTS)) elements.push({ ...el, frame: prefix, frameUrl: frame.url() });
        if (found.length > MAX_FRAME_ELEMENTS) notes.push(`Frame ${prefix} has ${found.length - MAX_FRAME_ELEMENTS} more elements than the ${MAX_FRAME_ELEMENTS} listed; read it with frame_evaluate.`);
      } catch {
        // A frame that navigated mid-read ("Execution context was destroyed") or did not
        // answer is not listed, and the snapshot says so instead of leaving it out quietly.
        if (!frame.isDetached()) unread++;
      }
    }
    if (skipped) notes.push(`${skipped} more iframe(s) were not read (limit ${MAX_SNAPSHOT_FRAMES} frames per snapshot).`);
    if (unread) notes.push(`${unread} iframe(s) could not be read (navigating, or not answering) and are not listed. Take browser_snapshot again.`);
  }
  if (unreadShadow.tooMany) notes.push(`${unreadShadow.tooMany} more shadow root(s) were not read (limit ${MAX_SHADOW_ROOTS} per document), so elements inside them are not listed. Narrow with roles=, or read them with evaluate.`);
  if (unreadShadow.tooDeep) notes.push(`${unreadShadow.tooDeep} shadow root(s) nested deeper than ${MAX_SHADOW_DEPTH} levels were not read, so elements inside them are not listed.`);
  return formatSnapshot(elements, page.url(), await page.title(), { ...opts, notes });
}
