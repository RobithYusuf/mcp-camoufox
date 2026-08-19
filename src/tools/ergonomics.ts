// The LLM-ergonomics kit: search_page, wait_for_change, assert_clickable, smart_fill, workflow_run and friends.
//
// Registered by importing this module — see src/index.ts.
import { z } from "zod";
import type { BrowserContext, Page, Dialog } from "playwright-core";
import { rmSync } from "fs";
import { S, PROFILE_DIR, getPage, consoleMessages, networkRequests, storageSnapshots } from "../state.js";
import { ACTION_TIMEOUT, jsStr, clickWithFallback, clickNote, fillLocator, refLocator,
         scopeRoot } from "../helpers.js";
import { regTool, toolRegistry } from "../server.js";

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


regTool("dialog_auto_handle",
  "Install a PERSISTENT dialog handler that stays armed across every dialog and every tab (dialog_handle is one-shot). " +
  "Reads its action at fire time, so you can change it without re-arming. Set enabled=false to remove it.",
  {
    action: z.enum(["accept", "dismiss"]).default("accept"),
    prompt_text: z.string().default("").describe("Text to submit for prompt() dialogs."),
    enabled: z.boolean().default(true),
  },
  async ({ action, prompt_text, enabled }) => {
    if (!S.browserUp) throw new Error("Browser not running. Call browser_launch first.");
    if (!enabled) {
      if (S.autoDialogHandler) for (const p of S.pages) { try { p.off("dialog", S.autoDialogHandler); } catch {} }
      S.autoDialogHandler = null; S.autoDialogCfg = null;
      return { content: [{ type: "text", text: "Persistent dialog handler removed. Dialogs fall back to Playwright's auto-dismiss." }] };
    }
    S.autoDialogCfg = { action, promptText: prompt_text };
    if (!S.autoDialogHandler) {
      S.autoDialogHandler = async (dialog: Dialog) => {
        // A one-shot dialog_handle takes precedence for the next dialog.
        if (S.oneShotDialogArmed) return;
        const cfg = S.autoDialogCfg;
        if (!cfg) { try { await dialog.dismiss(); } catch {} return; }
        try {
          if (cfg.action === "accept") await dialog.accept(cfg.promptText);
          else await dialog.dismiss();
        } catch {}
      };
      for (const p of S.pages) p.on("dialog", S.autoDialogHandler);
    }
    return { content: [{ type: "text", text: `Persistent dialog handler armed: every dialog will be ${action}'d (${S.pages.length} tab(s), new tabs inherit it). Call with enabled=false to remove.` }] };
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
    if (S.browserContext) {
      try {
        await Promise.race([S.browserContext.close(), new Promise(r => setTimeout(r, 5000))]);
        steps.push("context close attempted");
      } catch (e: any) { steps.push(`context close failed (ignored): ${String(e?.message || e).slice(0, 80)}`); }
    } else steps.push("no context held");
    if (S.activeProfileIsTemp && S.activeProfileDir) {
      try { rmSync(S.activeProfileDir, { recursive: true, force: true }); steps.push("temp profile removed"); } catch { steps.push("temp profile removal failed"); }
    }
    S.browserContext = null; S.pages = []; S.activePage = 0; S.browserUp = false;
    S.activeProfileDir = null; S.activeProfileIsTemp = false;
    consoleMessages.length = 0; networkRequests.length = 0; S.networkSeq = 0;
    S.networkCaptureBodies = false; S.networkHandler = null; S.consoleHandler = null;
    S.autoDialogHandler = null; S.autoDialogCfg = null; S.oneShotDialogArmed = false; S.oneShotDialogHandler = null;
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
