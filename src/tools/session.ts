// Storage state, cookie files, humanize, warmup, assertions and workflow helpers.
//
// Registered by importing this module — see src/index.ts.
import { z } from "zod";
import type { BrowserContext, Page, Dialog } from "playwright-core";
import { mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { PROFILE_PARENT, getPage } from "../state.js";
import { ACTION_TIMEOUT, safeName, writeSecretFile, expandHome, resolveOutPath,
         refLocator, hitTestAt, observeClick, pointerMove, pointerClick, navSeqOf, waitForUrl, waitReady,
         inflightOf, gotoReady } from "../helpers.js";
import { regTool } from "../server.js";

// ── Tools: Storage State (Session Reuse) ───────────────────────────────────

// about:blank and similar pages throw on any storage access. Their cookies are still
// worth saving, so a page without storage is not a failure.
const READ_WEB_STORAGE = `(() => {
  var data = { local: {}, session: {} };
  try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); data.local[k] = localStorage.getItem(k); } } catch (e) {}
  try { for (var j = 0; j < sessionStorage.length; j++) { var k2 = sessionStorage.key(j); data.session[k2] = sessionStorage.getItem(k2); } } catch (e) {}
  return { url: location.href, origin: location.origin, local: data.local, session: data.session };
})()`;

regTool("storage_state_save", "Save cookies and localStorage to a JSON file; storage_state_load restores the login in a fresh " +
  "browser.", {
  path: z.string().describe("Output file path (e.g. ~/.camoufox-mcp/sessions/site.json)"),
}, async ({ path }) => {
  const page = getPage();
  const ctx = page.context();
  const cookies = await ctx.cookies();
  const origins = await page.evaluate(READ_WEB_STORAGE);
  const target = resolveOutPath(path);
  writeSecretFile(target, JSON.stringify({ cookies, origins: [origins] }, null, 2));
  return { content: [{ type: "text", text: `Saved storage state: ${target} (${cookies.length} cookies, ${Object.keys((origins as any).local || {}).length} localStorage, ${Object.keys((origins as any).session || {}).length} sessionStorage)` }] };
});

regTool("storage_state_load", "Load cookies and localStorage from a storage_state_save file.", {
  path: z.string().describe("Path to storage state JSON file"),
  navigate_to: z.string().optional().describe("URL to open after loading (recommended: localStorage is per origin)"),
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
    await gotoReady(page, navigate_to);
    const origin = data.origins?.[0] || {};
    // The saved storage belongs to ONE origin. Landing somewhere else (an open
    // redirect, a login bounce) and writing it there hands those tokens to that
    // site, so require the origin to match what we actually ended up on.
    const landedOrigin = await page.evaluate("location.origin") as string;
    if ((origin.local || origin.session) && origin.origin && origin.origin !== landedOrigin) {
      return {
        content: [{ type: "text", text: `Loaded ${data.cookies?.length || 0} cookies, but REFUSED to write localStorage/sessionStorage: it was captured on ${origin.origin} and the browser landed on ${landedOrigin} (redirect?). Writing it there would hand those tokens to a different site. Navigate to ${origin.origin} and retry.` }],
        isError: true,
      };
    }
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

regTool("auth_capture", "Save the current session (cookies + localStorage) to ~/.camoufox-mcp/sessions/<name>.json. Shortcut " +
  "for storage_state_save.", {
  name: z.string().describe("Session name, e.g. 'github-bob'"),
}, async ({ name }) => {
  const page = getPage();
  const ctx = page.context();
  const cookies = await ctx.cookies();
  const origins = await page.evaluate(READ_WEB_STORAGE);
  const dir = join(PROFILE_PARENT, "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch {}
  const target = join(dir, `${safeName(name, "session")}.json`);
  writeSecretFile(target, JSON.stringify({ cookies, origins: [origins] }, null, 2));
  return { content: [{ type: "text", text: `auth_capture saved: ${target}` }] };
});

// ── Tools: Cookie Bulk ─────────────────────────────────────────────────────

regTool("cookie_export_file", "Export all cookies to a JSON file (Playwright format).", {
  path: z.string().describe("Output JSON file path"),
}, async ({ path }) => {
  const page = getPage();
  const cookies = await page.context().cookies();
  const target = resolveOutPath(path);
  writeSecretFile(target, JSON.stringify(cookies, null, 2));
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

regTool("humanize_click", "Click with a curved mouse approach before the click, for anti-bot pages.", {
  ref: z.string().optional().describe("Element ref from snapshot"),
  selector: z.string().optional().describe("CSS selector"),
}, async ({ ref, selector }) => {
  const page = getPage();
  if (!ref && !selector) return { content: [{ type: "text", text: "Error: ref or selector required" }], isError: true };
  const loc = ref ? refLocator(page, ref) : page.locator(selector!).first();
  if (await loc.count() === 0) return { content: [{ type: "text", text: `Not found: ${ref ? `ref=${ref}` : selector}. The ref may be from an older snapshot: call browser_snapshot again.` }], isError: true };
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
  // page.mouse has no idea what is under it, so without this a covered element reported
  // a clean click while the cover received it.
  const blocked = await hitTestAt(loc, { x: Math.max(0, tx - box.x), y: Math.max(0, ty - box.y) });
  if (blocked) return { content: [{ type: "text", text: blocked }], isError: true };
  const outcome = await observeClick(page, async () => {
    await pointerMove(page, tx + 200, ty - 100, { steps: 20 });
    await page.waitForTimeout(180 + Math.random() * 120);
    await pointerMove(page, tx + 60, ty - 25, { steps: 12 });
    await page.waitForTimeout(120 + Math.random() * 80);
    await pointerMove(page, tx, ty, { steps: 8 });
    await page.waitForTimeout(70 + Math.random() * 50);
    await pointerClick(page, tx, ty);
  }, 1000, ref);
  return { content: [{ type: "text", text: `humanize_click at (${Math.round(tx)},${Math.round(ty)}).\n${outcome.note}` }] };
});

regTool("humanize_type", "Type with Gaussian delays between keys (mean ~80ms, sigma ~30ms).", {
  ref: z.string().optional(),
  selector: z.string().optional(),
  text: z.string().describe("Text to type"),
  mean_delay_ms: z.number().default(80),
}, async ({ ref, selector, text, mean_delay_ms }) => {
  const page = getPage();
  if (ref) await refLocator(page, ref).focus({ timeout: ACTION_TIMEOUT });
  else if (selector) await page.locator(selector).first().focus({ timeout: ACTION_TIMEOUT });
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

regTool("mouse_drift", "Random mouse movement for a while, to build mouse history before an action (CF/DataDome behaviour " +
  "scoring).", {
  duration_ms: z.number().default(2000).describe("Total drift duration"),
  points: z.number().default(5).describe("Number of random destinations"),
}, async ({ duration_ms, points }) => {
  const page = getPage();
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const interval = duration_ms / points;
  for (let i = 0; i < points; i++) {
    const x = Math.floor(Math.random() * (vp.width - 100)) + 50;
    const y = Math.floor(Math.random() * (vp.height - 100)) + 50;
    await pointerMove(page, x, y, { steps: 12 });
    await page.waitForTimeout(interval * (0.7 + Math.random() * 0.6));
  }
  return { content: [{ type: "text", text: `mouse_drift: ${points} points over ${duration_ms}ms` }] };
});

regTool("mouse_record", "Record mouse positions in the page for mouse_replay (replaces any earlier recorder). mousemove only: " +
  "no clicks, and nothing inside cross-origin iframes such as a Turnstile widget.", {
  duration_ms: z.number().default(5000),
  max_points: z.number().default(2000).describe("Cap on stored points."),
}, async ({ duration_ms, max_points }) => {
  const page = getPage();
  const handle = `rec-${Date.now()}`;
  // Each recorder removes its OWN handler on expiry. The old version kept the
  // handler on a single global, so a second mouse_record made the first timeout
  // remove the NEW listener and leave the old one attached (and growing) for good.
  await page.evaluate(`(() => {
    if (window.__mcp_mouse_rec_handler) {
      try { document.removeEventListener('mousemove', window.__mcp_mouse_rec_handler); } catch (e) {}
      window.__mcp_mouse_rec_handler = null;
    }
    var cap = ${Math.max(1, max_points)};
    var rec = { points: [], start: Date.now() };
    window.__mcp_mouse_rec = rec;
    var h = function (e) { if (rec.points.length < cap) rec.points.push({ x: e.clientX, y: e.clientY, t: Date.now() - rec.start }); };
    window.__mcp_mouse_rec_handler = h;
    document.addEventListener('mousemove', h, { passive: true });
    setTimeout(function () {
      document.removeEventListener('mousemove', h);
      if (window.__mcp_mouse_rec_handler === h) window.__mcp_mouse_rec_handler = null;
    }, ${duration_ms});
  })()`);
  return { content: [{ type: "text", text: `mouse_record started: ${handle} (${duration_ms}ms, max ${max_points} points). Move the mouse, then call mouse_replay.` }] };
});

regTool("mouse_replay", "Replay the recorded mouse path with its timing. Moves only, never clicks, and it is still a " +
  "synthesized event.", {
  speed: z.number().default(1.0).describe("Replay speed multiplier (1.0=original, 2.0=2x faster)"),
}, async ({ speed }) => {
  const page = getPage();
  const points = await page.evaluate(`(window.__mcp_mouse_rec?.points || [])`) as any[];
  if (!points.length) return { content: [{ type: "text", text: "No recording found — call mouse_record first, then move the mouse." }], isError: true };
  let lastT = 0;
  for (const p of points) {
    const wait = (p.t - lastT) / speed;
    if (wait > 5) await page.waitForTimeout(wait);
    await pointerMove(page, p.x, p.y);
    lastT = p.t;
  }
  return { content: [{ type: "text", text: `mouse_replay: ${points.length} points moved (no click issued).` }] };
});

// ── Tools: Session Warmup & Anti-Bot Detection ─────────────────────────────

regTool("session_warmup", "Visit harmless public sites (Google, Wikipedia) to build history before a protected site " +
  "(CF/DataDome IP scoring).", {
  duration_ms: z.number().default(10000).describe("Total warmup time"),
  sites: z.array(z.string()).optional().describe("URLs to visit (default: google.com, wikipedia.org)"),
}, async ({ duration_ms, sites }) => {
  const page = getPage();
  const urls = sites && sites.length ? sites : [
    "https://www.google.com", "https://en.wikipedia.org/wiki/Special:Random",
  ];
  const per = Math.floor(duration_ms / urls.length);
  const failed: string[] = [];
  for (const url of urls) {
    try {
      await gotoReady(page, url, "domcontentloaded", 15000);
      await page.waitForTimeout(per * 0.4);
      // Random scroll — via window.scrollBy, since mouse.wheel is a no-op in Camoufox
      const dy = Math.round(200 + Math.random() * 400);
      await page.evaluate(`window.scrollBy(0, ${dy})`).catch(() => {});
      await page.waitForTimeout(per * 0.3);
    } catch (e: any) { failed.push(`${url} (${String(e?.message || e).split("\n")[0].slice(0, 80)})`); }
  }
  const ok = urls.length - failed.length;
  return {
    content: [{ type: "text", text: `session_warmup: visited ${ok} of ${urls.length} sites over ${duration_ms}ms${failed.length ? `. Failed: ${failed.join("; ")}` : ""}` }],
    ...(ok === 0 ? { isError: true } : {}),
  };
});

regTool("detect_anti_bot", "Guess the anti-bot vendor on the page (Cloudflare, DataDome, Akamai, PerimeterX, Imperva) and " +
  "whether the page is currently a challenge (`challenged`). A vendor with challenged=false only means " +
  "its scripts are loaded.", {}, async () => {
  const page = getPage();
  const result = await page.evaluate(`(() => {
    var html = document.documentElement.outerHTML.slice(0, 50000);
    var title = document.title;
    var hits = [];
    if (/challenges\\.cloudflare|__cf_chl|cf-turnstile|turnstile/i.test(html) || /cloudflare/i.test(title)) hits.push("Cloudflare");
    if (/datadome|dd-captcha|js\\.datadome\\.co/i.test(html)) hits.push("DataDome");
    if (/akamai|akam\\.net|_bm\\.|bot-detector\\.akamai/i.test(html)) hits.push("Akamai");
    if (/perimeterx|px-captcha|_pxhd/i.test(html)) hits.push("PerimeterX");
    if (/imperva|incapsula/i.test(html)) hits.push("Imperva");
    if (/recaptcha|g-recaptcha|grecaptcha/i.test(html)) hits.push("reCAPTCHA");
    if (/hcaptcha/i.test(html)) hits.push("hCaptcha");
    // An interstitial currently BLOCKING the page — distinct from a vendor whose
    // scripts are just loaded on an already-passed page. Title phrasing is the
    // clearest signal; __cf_chl_ / turnstile markers back it up for Cloudflare.
    var challenged = /just a moment|checking your browser|verifying you are human|performing security|attention required|access denied|verify you are (a )?human|one more step|please wait/i.test(title)
      || /__cf_chl_|cpo\\.src\\s*=\\s*["']\\/cdn-cgi\\/challenge-platform|id=["']cf-challenge|px-captcha|dd-captcha|geo\\.captcha-delivery/i.test(html);
    return { vendors: hits, challenged: challenged, title: title, url: location.href };
  })()`) as any;
  const note = result.vendors.length && !result.challenged
    ? "\n\nNote: a vendor is present but challenged=false — the page appears to be real content, not a block."
    : (result.challenged ? "\n\nNote: challenged=true — this page is an interstitial, not the content you navigated for." : "");
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) + note }] };
});

// ── Tools: Assertions ──────────────────────────────────────────────────────

regTool("assert_element_visible", "Assert an element exists and is visible. A failure is an error reply, so batches and workflows count " +
  "it.", {
  selector: z.string(),
}, async ({ selector }) => {
  const page = getPage();
  try {
    const el = page.locator(selector).first();
    const visible = await el.isVisible({ timeout: 3000 });
    return { content: [{ type: "text", text: visible ? `PASS: ${selector} visible` : `FAIL: ${selector} not visible` }], ...(visible ? {} : { isError: true }) };
  } catch (e: any) {
    return { content: [{ type: "text", text: `FAIL: ${selector} not found (${e.message?.slice(0, 80)})` }], isError: true };
  }
});

regTool("assert_text_present", "Assert text is present anywhere on page (case-sensitive substring).", {
  text: z.string(),
}, async ({ text }) => {
  const page = getPage();
  // Do the substring test in-page so we ship back a boolean, not the entire
  // document text (which can be megabytes on large S.pages).
  const found = await page.evaluate(
    `document.body.innerText.includes(${JSON.stringify(text)})`
  ) as boolean;
  return { content: [{ type: "text", text: found ? `PASS: '${text}' present` : `FAIL: '${text}' not found in body` }], ...(found ? {} : { isError: true }) };
});

regTool("assert_url_matches", "Assert current URL matches pattern (substring or regex).", {
  pattern: z.string(),
  regex: z.boolean().default(false),
}, async ({ pattern, regex }) => {
  const page = getPage();
  const url = page.url();
  const match = regex ? new RegExp(pattern).test(url) : url.includes(pattern);
  return { content: [{ type: "text", text: match ? `PASS: URL '${url}' matches '${pattern}'` : `FAIL: URL '${url}' does not match '${pattern}'` }], ...(match ? {} : { isError: true }) };
});

// ── Tools: Convenience / Workflow ──────────────────────────────────────────

regTool("click_and_wait", "Click, then wait for a selector or URL in the same call.", {
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
  const seq = navSeqOf(page);
  await loc.click({ timeout: timeout_ms });
  // The conditions are polled rather than handed to page.waitForURL, which waits for the
  // load event: Camoufox stops delivering that after the fifth page in a context, so a
  // navigation that worked read as a timeout.
  if (wait_for_url) {
    if (!await waitForUrl(page, u => u.includes(wait_for_url), timeout_ms)) {
      return { content: [{ type: "text", text: `click_and_wait: the CLICK happened but the wait did NOT succeed — url contains "${wait_for_url}" was never met within ${timeout_ms}ms. URL: ${beforeUrl} → ${page.url()}` }], isError: true };
    }
    return { content: [{ type: "text", text: `click_and_wait: url contains "${wait_for_url}" met. ${beforeUrl} → ${page.url()}` }] };
  }
  if (wait_for_selector) {
    try {
      await page.locator(wait_for_selector).first().waitFor({ state: "visible", timeout: timeout_ms });
    } catch (e: any) {
      return { content: [{ type: "text", text: `click_and_wait: the CLICK happened but the wait did NOT succeed — selector "${wait_for_selector}" was never met within ${timeout_ms}ms (${String(e?.message || e).split("\n")[0].slice(0, 140)}). URL: ${beforeUrl} → ${page.url()}` }], isError: true };
    }
    return { content: [{ type: "text", text: `click_and_wait: selector "${wait_for_selector}" met. ${beforeUrl} → ${page.url()}` }] };
  }
  // No condition given. A click may simply not navigate, so this is not an error, but it
  // must not claim a load happened either.
  const deadline = Date.now() + Math.min(timeout_ms, 3000);
  while (navSeqOf(page) === seq && Date.now() < deadline) await page.waitForTimeout(50);
  if (navSeqOf(page) === seq) {
    return { content: [{ type: "text", text: `click_and_wait: clicked, no navigation within ${Math.min(timeout_ms, 3000)}ms. URL: ${page.url()}` }] };
  }
  await waitReady(page, "domcontentloaded", timeout_ms);
  return { content: [{ type: "text", text: `click_and_wait: navigated and loaded. ${beforeUrl} → ${page.url()}` }] };
});

regTool("wait_for_network_idle", "Wait until no request has been in flight for idle_ms. A request already in flight when this is " +
  "called counts.", {
  idle_ms: z.number().default(500).describe("How long the network must stay quiet before returning."),
  timeout_ms: z.number().default(30000),
}, async ({ idle_ms, timeout_ms }) => {
  const page = getPage();
  const started = Date.now();
  const deadline = started + timeout_ms;
  let quietSince = inflightOf(page) === 0 ? started : 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    if (inflightOf(page) === 0) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= idle_ms) {
        return { content: [{ type: "text", text: `network idle for ${idle_ms}ms (waited ${Date.now() - started}ms)` }] };
      }
    } else {
      quietSince = 0;
    }
  }
  return { content: [{ type: "text", text: `timeout after ${timeout_ms}ms — still ${inflightOf(page)} request(s) in flight (never idle for ${idle_ms}ms).` }], isError: true };
});

regTool(
  "describe_page",
  "Compact page summary (title, headings, key buttons, forms), cheaper than browser_snapshot. Includes " +
  "`intent`: login_email, login_password, otp_input, captcha, stay_signed_in, protect_account, " +
  "error_page, consent, two_factor, account_disabled, content or unknown.",
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
