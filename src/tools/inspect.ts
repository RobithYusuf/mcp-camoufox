// Element inspection, storage, mouse, frames, viewport, accessibility, debug and export.
//
// Registered by importing this module — see src/index.ts.
import { z } from "zod";
import type { BrowserContext, Page, Dialog } from "playwright-core";
import { writeFileSync } from "fs";
import { join } from "path";
import { S, PROFILE_DIR, SCREENSHOT_DIR, getPage, networkRequests } from "../state.js";
import { PKG_VERSION, ACTION_TIMEOUT, jsStr, resolveOutPath,
         refLocator } from "../helpers.js";
import { regTool } from "../server.js";

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
      text: (el.innerText || "").slice(0, 200),
      value: (function () {
        var v = el.value || "";
        if (!v) return "";
        var ty = (el.type || "").toLowerCase();
        var hint = ((el.name || "") + " " + (el.id || "") + " " + (el.getAttribute("autocomplete") || "")).toLowerCase();
        return (ty === "password" || /pass|secret|token|otp|cvv|card|pin/.test(hint)) ? "••• " + v.length + " chars (masked)" : v;
      })(),
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
    browser_up: S.browserUp,
    active_tabs: S.pages.length,
    active_page: S.activePage,
    current_url: S.browserUp && S.pages.length > 0 ? S.pages[S.activePage]?.url() : null,
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
  if (!S.browserContext) throw new Error("Browser not running. Call browser_launch first.");
  await S.browserContext.addInitScript(script);
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
  const bodyNote = S.networkCaptureBodies ? "" : " (no headers/bodies — restart with network_start capture_bodies=true)";
  return { content: [{ type: "text", text: `HAR exported: ${target} (${entries.length} entries)${bodyNote}` }] };
});

// ── Tool: Fingerprint audit ────────────────────────────────────────────────

regTool("fingerprint_audit",
  "Report the fingerprint a site actually sees from this browser, and flag internal contradictions — the mismatches that get an " +
  "automated browser detected are far more revealing than any single value. Read-only: it inspects, it does not change anything.",
  {},
  async () => {
    const page = getPage();
    // IIFE + var: Camoufox does not reliably auto-invoke string arrow functions.
    const raw = await page.evaluate(`(function () {
      var out = {};
      var n = navigator, s = screen;
      out.userAgent = n.userAgent;
      out.platform = n.platform;
      out.languages = (n.languages || []).join(",");
      out.language = n.language;
      out.hardwareConcurrency = n.hardwareConcurrency;
      out.deviceMemory = n.deviceMemory === undefined ? null : n.deviceMemory;
      out.maxTouchPoints = n.maxTouchPoints;
      out.webdriver = n.webdriver === undefined ? null : n.webdriver;
      out.plugins = n.plugins ? n.plugins.length : -1;
      out.mimeTypes = n.mimeTypes ? n.mimeTypes.length : -1;
      out.pdfViewerEnabled = n.pdfViewerEnabled === undefined ? null : n.pdfViewerEnabled;
      out.screen = s.width + "x" + s.height;
      out.availScreen = s.availWidth + "x" + s.availHeight;
      out.colorDepth = s.colorDepth;
      out.pixelRatio = window.devicePixelRatio;
      out.inner = window.innerWidth + "x" + window.innerHeight;
      out.outer = window.outerWidth + "x" + window.outerHeight;
      out.hasChromeObject = typeof window.chrome !== "undefined";
      try { var dtf = Intl.DateTimeFormat().resolvedOptions(); out.timezone = dtf.timeZone; out.locale = dtf.locale; } catch (e) { out.timezone = "?"; out.locale = "?"; }
      out.tzOffsetMin = new Date().getTimezoneOffset();
      try {
        var cv = document.createElement("canvas");
        var gl = cv.getContext("webgl") || cv.getContext("experimental-webgl");
        if (gl) {
          var dbg = gl.getExtension("WEBGL_debug_renderer_info");
          out.webglVendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
          out.webglRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        } else { out.webglVendor = null; out.webglRenderer = null; }
      } catch (e) { out.webglVendor = "error"; out.webglRenderer = String(e).slice(0, 60); }
      return JSON.stringify(out);
    })()`) as string;
    const f = JSON.parse(raw);

    // Contradictions. Each one is a real detection signal, not a style note.
    const flags: string[] = [];
    if (f.webdriver === true) flags.push("navigator.webdriver is TRUE — this is the single most checked automation tell.");
    if (f.hasChromeObject) flags.push("window.chrome exists on a Firefox user-agent — a Chrome-only object on a Firefox UA is a contradiction.");
    const ua = String(f.userAgent || "");
    if (/Headless/i.test(ua)) flags.push("The user-agent contains 'Headless'.");
    const uaSaysMac = /Macintosh/i.test(ua), uaSaysWin = /Windows/i.test(ua), uaSaysLinux = /Linux|X11/i.test(ua);
    const plat = String(f.platform || "");
    if ((uaSaysMac && !/Mac/i.test(plat)) || (uaSaysWin && !/Win/i.test(plat)) || (uaSaysLinux && !/Linux|arm|x86/i.test(plat))) {
      flags.push(`navigator.platform "${plat}" does not match the OS in the user-agent.`);
    }
    const [sw, sh] = String(f.screen || "0x0").split("x").map(Number);
    const [iw, ih] = String(f.inner || "0x0").split("x").map(Number);
    if (iw > sw || ih > sh) {
      flags.push(`The viewport (${f.inner}) is larger than the screen (${f.screen}) — impossible on a real display. This is what no_viewport=true causes; use set_viewport_size instead.`);
    }
    if (f.plugins === 0 && f.mimeTypes === 0) flags.push("navigator.plugins and mimeTypes are both empty — common in crude headless setups.");
    if (f.hardwareConcurrency === 0 || f.hardwareConcurrency === undefined) flags.push("navigator.hardwareConcurrency is missing or zero.");

    const lines = [
      `Fingerprint as the page sees it`,
      ``,
      `  user-agent   ${f.userAgent}`,
      `  platform     ${f.platform}          languages  ${f.languages}`,
      `  timezone     ${f.timezone} (offset ${f.tzOffsetMin}m)   locale  ${f.locale}`,
      `  screen       ${f.screen} (avail ${f.availScreen}, depth ${f.colorDepth}, dpr ${f.pixelRatio})`,
      `  window       inner ${f.inner} / outer ${f.outer}`,
      `  cores        ${f.hardwareConcurrency}      memory ${f.deviceMemory ?? "not exposed"}      touch ${f.maxTouchPoints}`,
      `  webdriver    ${f.webdriver === null ? "undefined (good)" : f.webdriver}`,
      `  plugins      ${f.plugins}   mimeTypes ${f.mimeTypes}   pdfViewer ${f.pdfViewerEnabled}`,
      `  webgl        ${f.webglVendor ?? "unavailable"} / ${f.webglRenderer ?? "unavailable"}`,
      ``,
      flags.length ? `⚠ ${flags.length} contradiction(s) a detector could use:` : `No internal contradictions found in the values above.`,
      ...flags.map(x => `  • ${x}`),
      ``,
      `This checks self-consistency only. It cannot tell you whether a specific site's detector`,
      `passes you — for that, drive a real challenge page and read the outcome.`,
    ];
    return { content: [{ type: "text", text: lines.filter(l => l !== undefined).join("\n") }] };
  });
