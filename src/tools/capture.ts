// Console/network capture, PDF and batch operations.
//
// Registered by importing this module — see src/index.ts.
import { z } from "zod";
import type { BrowserContext, Page, Dialog } from "playwright-core";
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "fs";
import { join } from "path";
import { S, SCREENSHOT_DIR, getPage, consoleMessages, networkRequests, interceptLog, type NetEntry } from "../state.js";
import { ACTION_TIMEOUT, resolveOutPath,
         totpFromSecret, clickWithFallback, clickReply, fillLocator, refLocator,
         snapshotPage, urlMatches, gotoReady, settle } from "../helpers.js";
import { maskUrl, maskHeaders, maskHeaderValue, maskBody, isSecretName, scrubErrorText } from "../redact.js";
import { regTool } from "../server.js";

// ── Tools: Console & Network ───────────────────────────────────────────────



regTool("console_start", "Start capturing console messages from all tabs.", {}, async () => {
  if (!S.browserContext) throw new Error("Browser not running. Call browser_launch first.");
  consoleMessages.length = 0;
  // Detach any prior handler from every page first so repeated console_start
  // calls don't stack listeners (and don't capture each message N times).
  if (S.consoleHandler) for (const p of S.pages) { try { p.off("console", S.consoleHandler); } catch {} }
  S.consoleHandler = (msg: any) => {
    consoleMessages.push({ type: msg.type(), text: msg.text().slice(0, 200) });
    // Bounded like networkRequests — a chatty (or hostile) page must not grow
    // this without limit for the life of the server.
    if (consoleMessages.length > 1000) consoleMessages.shift();
  };
  // Attach to every current page; trackPage() attaches it to future tabs/popups,
  // so capture follows the user across tab switches instead of dying on tab 0.
  for (const p of S.pages) p.on("console", S.consoleHandler);
  return { content: [{ type: "text", text: `Console capture started (all ${S.pages.length} tab(s)).` }] };
});

regTool("console_get", "Get captured console messages.", {}, async () => {
  // "No messages" with no capture running would read like a quiet page.
  if (!S.consoleHandler) return { content: [{ type: "text", text: "Console capture is not running, so nothing was measured. Call console_start first." }] };
  if (!consoleMessages.length) return { content: [{ type: "text", text: "Console capture is running; no messages yet." }] };
  const lines = consoleMessages.slice(-50).map(m => `  [${m.type}] ${m.text}`);
  return { content: [{ type: "text", text: `Console (${consoleMessages.length}):\n${lines.join("\n")}` }] };
});

regTool("network_start",
  "Start capturing requests on every tab. capture_bodies=true also keeps headers and text bodies " +
  "(json/text/xml/form, up to body_limit bytes) for network_get_detail.",
  {
    capture_bodies: z.boolean().default(false).describe("Also capture request/response headers and text bodies."),
    body_limit: z.number().default(50000).describe("Max bytes kept per request/response body."),
  },
  async ({ capture_bodies, body_limit }) => {
    if (!S.browserContext) throw new Error("Browser not running. Call browser_launch first.");
    networkRequests.length = 0;
    S.networkSeq = 0;
    S.networkCaptureBodies = capture_bodies;
    // Detach a prior handler from every page so repeated network_start calls
    // don't stack listeners or orphan the handler on a since-switched tab.
    if (S.networkHandler) for (const p of S.pages) { try { p.off("response", S.networkHandler); } catch {} }
    S.networkHandler = (res: any) => {
      // Fire-and-forget: body reads are async and must not block the event loop.
      (async () => {
        try {
          const req = res.request();
          const entry: NetEntry = {
            id: S.networkSeq++,
            ts: Date.now(),
            method: req.method(),
            status: res.status(),
            url: res.url(),
            resourceType: typeof req.resourceType === "function" ? req.resourceType() : "",
          };
          if (S.networkCaptureBodies) {
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
    for (const p of S.pages) p.on("response", S.networkHandler);
    return { content: [{ type: "text", text: `Network capture started${capture_bodies ? ` (bodies ON, limit ${body_limit}B)` : ""} on ${S.pages.length} tab(s).` }] };
  });

regTool("network_get",
  "List captured requests, the newest `limit` rows, each with an #id for network_get_detail.",
  {
    filter: z.string().default("").describe("Only URLs containing this."),
    limit: z.number().default(50).describe("Max rows to return."),
    reveal_values: z.boolean().default(false).describe("Show credentials in URLs. Masked by default."),
  },
  async ({ filter, limit, reveal_values }) => {
    let rows = networkRequests;
    if (filter) rows = rows.filter(r => r.url.includes(filter));
    if (!S.networkHandler && !networkRequests.length) return { content: [{ type: "text", text: "Network capture is not running, so nothing was measured. Call network_start first." }] };
    if (!rows.length) return { content: [{ type: "text", text: filter ? `No requests match "${filter}".` : "Network capture is running; no requests yet." }] };
    const slice = rows.slice(-limit);
    const lines = slice.map(r => `  #${r.id} ${r.method} ${r.status} ${(reveal_values ? r.url : maskUrl(r.url)).slice(0, 160)}`);
    const hint = S.networkCaptureBodies
      ? "\n(bodies captured — network_get_detail(id) for full request/response)"
      : "\n(headers/bodies NOT captured — restart with network_start capture_bodies=true)";
    return { content: [{ type: "text", text: `Network (${rows.length}${filter ? " matched" : ""}):\n${lines.join("\n")}${hint}` }] };
  });

regTool("network_get_detail",
  "Headers and text body of one captured request and its response. Needs " +
  "network_start(capture_bodies=true) BEFORE the request fired. Pick by id or URL substring.",
  {
    id: z.number().default(-1).describe("Request #id from network_get. -1 = match by url instead."),
    url: z.string().default("").describe("With id=-1: the newest request whose URL contains this."),
    reveal_values: z.boolean().default(false).describe("Show Cookie, Authorization, Set-Cookie, tokens and passwords. Masked by default."),
  },
  async ({ id, url, reveal_values }) => {
    let entry: NetEntry | undefined;
    if (id >= 0) entry = networkRequests.find(r => r.id === id);
    else if (url) { const m = networkRequests.filter(r => r.url.includes(url)); entry = m[m.length - 1]; }
    if (!entry) return { content: [{ type: "text", text: "No matching request. Run network_get to list ids." }], isError: true };
    if (!S.networkCaptureBodies && !entry.reqHeaders && !entry.resBody) {
      return { content: [{ type: "text", text: `Request #${entry.id} found, but bodies weren't captured. Run network_start(capture_bodies=true), replay the action, then retry.` }] };
    }
    const show = (b: string) => reveal_values ? b : maskBody(b);
    const fmtH = (h?: Record<string, string>) => h ? Object.entries(reveal_values ? h : maskHeaders(h)!).map(([k, v]) => `    ${k}: ${v}`).join("\n") : "    (none)";
    const out = [
      `#${entry.id} ${entry.method} ${entry.status}  ${reveal_values ? entry.url : maskUrl(entry.url)}`,
      `resourceType: ${entry.resourceType || "?"}  mime: ${entry.mimeType || "?"}`,
      "", "── Request headers ──", fmtH(entry.reqHeaders),
      ...(entry.reqBody ? ["", "── Request body ──", show(entry.reqBody)] : []),
      "", "── Response headers ──", fmtH(entry.resHeaders),
      "", "── Response body ──",
      entry.resBody ? (show(entry.resBody) + (entry.resBodyTruncated ? "\n…(truncated)" : "")) : "(empty / binary / not captured)",
    ];
    return { content: [{ type: "text", text: out.join("\n") }] };
  });

// ── Tools: PDF ─────────────────────────────────────────────────────────────

regTool("save_pdf",
  "Always fails here: PDF output is Chromium-only and Camoufox is Firefox. Use " +
  "screenshot(full_page=true). Kept for API compatibility.",
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

regTool("batch_actions", "Run several actions in one call. Each action: {type, ref?, value?, text?, key?, timeout?}. Stops at " +
  "the first failure by default; any failure makes the reply an error.", {
  actions: z.array(z.object({
    type: z.enum(["click", "fill", "type", "press", "select", "check", "uncheck", "wait"]),
    ref: z.string().optional(),
    value: z.string().optional(),
    text: z.string().optional(),
    key: z.string().optional(),
    timeout: z.number().optional(),
  })).describe("Actions, run in order"),
  stop_on_error: z.boolean().default(true).describe("false = run the rest after a failure."),
}, async ({ actions, stop_on_error }) => {
  const page = getPage();
  const results: string[] = [];
  let failed = 0, ran = 0;
  const needs = (a: any): string | null => {
    if (["click", "fill", "select", "check", "uncheck"].includes(a.type) && !a.ref) return "needs ref";
    if ((a.type === "fill" || a.type === "select") && a.value === undefined) return "needs value";
    if (a.type === "type" && a.text === undefined) return "needs text";
    if (a.type === "press" && !a.key) return "needs key";
    return null;
  };
  for (const action of actions) {
    ran++;
    try {
      const missing = needs(action);
      if (missing) throw new Error(missing);
      if (action.type === "click") {
        const res = await clickWithFallback(refLocator(page, action.ref!));
        results.push(`click ${action.ref}: OK${res.mode === "fallback" ? " (⚠ synthetic fallback — verify effect)" : ""}`);
      } else if (action.type === "fill") {
        await fillLocator(refLocator(page, action.ref!), action.value!);
        results.push(`fill ${action.ref}: OK`);
      } else if (action.type === "type") {
        await page.keyboard.type(action.text!, { delay: 50 });
        results.push(`type: OK`);
      } else if (action.type === "press") {
        await page.keyboard.press(action.key!);
        results.push(`press ${action.key}: OK`);
      } else if (action.type === "select") {
        await refLocator(page, action.ref!).selectOption(action.value!, { timeout: ACTION_TIMEOUT });
        results.push(`select ${action.ref}: OK`);
      } else if (action.type === "check") {
        await refLocator(page, action.ref!).check({ timeout: ACTION_TIMEOUT });
        results.push(`check ${action.ref}: OK`);
      } else if (action.type === "uncheck") {
        await refLocator(page, action.ref!).uncheck({ timeout: ACTION_TIMEOUT });
        results.push(`uncheck ${action.ref}: OK`);
      } else if (action.type === "wait") {
        await page.waitForTimeout(action.timeout || 1000);
        results.push(`wait ${action.timeout || 1000}ms: OK`);
      }
      await page.waitForTimeout(300);
    } catch (e: any) {
      failed++;
      results.push(`${action.type} ${action.ref || ""}: FAIL — ${scrubErrorText(String(e?.message || e)).split("\n")[0].slice(0, 160)}`);
      if (stop_on_error) break;
    }
  }
  const notRun = actions.length - ran;
  return {
    content: [{ type: "text", text: `Batch: ${ran - failed} OK, ${failed} failed, ${notRun} not run (of ${actions.length}).\n${results.map(r => "  " + r).join("\n")}` }],
    ...(failed ? { isError: true } : {}),
  };
});

regTool("fill_form", "Fill several fields, then optionally click submit_ref. If any field fails, the reply names it and " +
  "nothing is submitted.", {
  fields: z.array(z.object({
    ref: z.string().describe("Element ref from snapshot"),
    value: z.string().describe("Value to fill"),
  })),
  submit_ref: z.string().optional().describe("Ref of submit button to click after filling"),
}, async ({ fields, submit_ref }) => {
  const page = getPage();
  for (let i = 0; i < fields.length; i++) {
    try {
      await fillLocator(refLocator(page, fields[i].ref), fields[i].value);
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Filled ${i} of ${fields.length} fields, then ref=${fields[i].ref} failed, so nothing was submitted: ${String(e?.message || e)}` }],
        isError: true,
      };
    }
  }
  if (submit_ref) {
    return clickReply(page, `Filled ${fields.length} fields + submitted`, () => clickWithFallback(refLocator(page, submit_ref)), 1000, submit_ref);
  }
  return { content: [{ type: "text", text: `Filled ${fields.length} fields. URL: ${page.url()}` }] };
});

regTool("login_classic",
  "One-call login for classic email→password forms (Google, Microsoft, generic SSO): fills the email, " +
  "clicks Next on multi-step forms, fills the password, submits, and enters a TOTP code if asked. " +
  "Heuristic: for an unusual form use fill/click. Returns the step log and a snapshot.",
  {
    email: z.string().describe("Email / username to fill."),
    password: z.string().describe("Password to fill."),
    totp_secret: z.string().default("").describe("Base32 TOTP secret; a code is generated if a 2FA field appears."),
    totp_code: z.string().default("").describe("6-digit 2FA code (overrides totp_secret)."),
    submit_after_email: z.boolean().default(true).describe("Click Next/Continue after the email (multi-step forms)."),
    step_timeout_ms: z.number().default(8000).describe("Max wait for each step's field."),
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
      return {
        content: [{ type: "text" as const, text: `login_classic: ${note}\nsteps: ${log.join(" → ") || "(none)"}\n\n${snap}` }],
        ...(note.startsWith("FAILED") ? { isError: true } : {}),
      };
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
        log.push("2FA code filled (value masked)");
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
  await gotoReady(page, url, wait_until, 30000);
  await settle(page, 1500);
  const text = await snapshotPage(page);
  return { content: [{ type: "text", text }] };
});


// ── Tools: Request interception ────────────────────────────────────────────
//
// Routing lives on the BrowserContext, not the page: a per-page route would miss
// every tab the site opens, and would have to be re-attached by trackPage.

regTool("intercept_start",
  "Block requests before they leave the browser, on every tab including later ones. Blocking " +
  "image/media/font/stylesheet removes most bytes when scraping; block_urls drops trackers. Re-calling " +
  "replaces the rules; intercept_stop removes them. 'document' cannot be blocked.",
  {
    block_types: z.array(z.enum(["image", "media", "font", "stylesheet", "script", "xhr", "fetch", "websocket", "other"]))
      .default([]).describe("Resource types to abort."),
    block_urls: z.array(z.string()).default([])
      .describe("URL substrings, * = wildcard (e.g. *doubleclick.net*)."),
    log_limit: z.number().default(300).describe("Decisions kept for intercept_log."),
  },
  async ({ block_types, block_urls, log_limit }) => {
    if (!S.browserContext) throw new Error("Browser not running. Call browser_launch first.");
    if (!block_types.length && !block_urls.length) {
      throw new Error("Nothing to block: pass block_types and/or block_urls. Use intercept_stop to remove existing rules.");
    }
    if (S.interceptHandler) { try { await S.browserContext.unroute("**/*", S.interceptHandler); } catch {} }
    interceptLog.length = 0;
    S.interceptBlocked = 0; S.interceptAllowed = 0;
    S.interceptHandler = async (route: any, request: any) => {
      // A route handler that neither continues nor aborts hangs that request
      // forever, so every path below ends in exactly one of the two.
      let type = "other", url = "";
      try { type = request.resourceType(); url = request.url(); } catch {}
      try {
        const byType = block_types.includes(type as any);
        const pattern = block_urls.find(p => urlMatches(url, p));
        if (byType || pattern) {
          S.interceptBlocked++;
          if (interceptLog.length < log_limit) {
            interceptLog.push({ action: "block", type, url, why: byType ? `type=${type}` : `url~${pattern}` });
          }
          await route.abort();
          return;
        }
        S.interceptAllowed++;
        if (interceptLog.length < log_limit) interceptLog.push({ action: "allow", type, url, why: "" });
        await route.continue();
      } catch {
        // Never leave the request dangling because our own bookkeeping threw.
        try { await route.continue(); } catch {}
      }
    };
    await S.browserContext.route("**/*", S.interceptHandler);
    const rules = [block_types.length ? `types: ${block_types.join(", ")}` : "", block_urls.length ? `urls: ${block_urls.join(", ")}` : ""].filter(Boolean).join(" | ");
    return { content: [{ type: "text", text: `Interception ON — blocking ${rules}. Applies to every tab, including ones opened later. Check intercept_log for what it actually did.` }] };
  });

regTool("intercept_stop", "Remove interception rules and report what they blocked.", {}, async () => {
  if (!S.browserContext) throw new Error("Browser not running. Call browser_launch first.");
  if (!S.interceptHandler) return { content: [{ type: "text", text: "Interception was not active." }] };
  try { await S.browserContext.unroute("**/*", S.interceptHandler); } catch {}
  S.interceptHandler = null;
  const t = `Interception OFF. Blocked ${S.interceptBlocked}, allowed ${S.interceptAllowed}.`;
  return { content: [{ type: "text", text: t }] };
});

regTool("intercept_log", "Show what interception blocked and allowed.", {
  action: z.enum(["block", "allow", "all"]).default("block"),
  limit: z.number().default(50),
  reveal_values: z.boolean().default(false).describe("Show credentials in URLs. Masked by default."),
}, async ({ action, limit, reveal_values }) => {
  if (!S.interceptHandler && !interceptLog.length) {
    return { content: [{ type: "text", text: "Interception is not active and nothing was logged. Start it with intercept_start." }] };
  }
  const rows = interceptLog.filter(e => action === "all" || e.action === action).slice(-limit);
  const head = `Interception ${S.interceptHandler ? "ON" : "OFF"} — blocked ${S.interceptBlocked}, allowed ${S.interceptAllowed}. Showing last ${rows.length} (${action}).`;
  if (!rows.length) return { content: [{ type: "text", text: `${head}\nNo matching entries.` }] };
  const body = rows.map(e => `${e.action === "block" ? "✗" : "·"} [${e.type}] ${(reveal_values ? e.url : maskUrl(e.url)).slice(0, 140)}${e.why ? `  (${e.why})` : ""}`).join("\n");
  return { content: [{ type: "text", text: `${head}\n${body}` }] };
});

regTool("export_curl",
  "Rebuild a captured request as a runnable curl command. Needs network_start(capture_bodies=true) " +
  "before the request; headers are not recorded otherwise.",
  {
    url_contains: z.string().default("").describe("Newest captured request whose URL contains this."),
    id: z.number().default(-1).describe("Or pick by id from network_get."),
    reveal_values: z.boolean().default(false).describe("Put the real Cookie, Authorization, tokens and passwords in the command. Placeholders by default."),
  },
  async ({ url_contains, id, reveal_values }) => {
    const pool = networkRequests.filter(e => (id >= 0 ? e.id === id : (!url_contains || e.url.includes(url_contains))));
    const entry = pool[pool.length - 1];
    if (!entry) {
      return { content: [{ type: "text", text: `No captured request matches${id >= 0 ? ` id=${id}` : url_contains ? ` "${url_contains}"` : ""}. ${networkRequests.length} request(s) captured — call network_start first, then reload the page.` }], isError: true };
    }
    if (!entry.reqHeaders) {
      return { content: [{ type: "text", text: `Request ${entry.id} was captured without headers, so a curl built from it would not reproduce the call. Re-run network_start(capture_bodies=true) and repeat the request.` }], isError: true };
    }
    const q = (v: string) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    const parts = [`curl -X ${entry.method} ${q(reveal_values ? entry.url : maskUrl(entry.url))}`];
    const carried: string[] = [];
    for (const [k, v] of Object.entries(entry.reqHeaders)) {
      if (k.startsWith(":")) continue;                       // pseudo-headers are not curl's business
      const shown = reveal_values ? v : maskHeaderValue(k, v);
      if (shown !== v || (reveal_values && (isSecretName(k) || /^(cookie|set-cookie)$/i.test(k)))) carried.push(k);
      parts.push(`  -H ${q(`${k}: ${shown}`)}`);
    }
    if (entry.reqBody) parts.push(`  --data-raw ${q(reveal_values ? entry.reqBody : maskBody(entry.reqBody))}`);
    const warn = carried.length && reveal_values
      ? `\n\n⚠ This command carries live credentials (${carried.join(", ")}). Treat it as a secret — do not paste it into an issue or a shared doc.`
      : (!reveal_values && (carried.length || maskUrl(entry.url) !== entry.url || (entry.reqBody && maskBody(entry.reqBody) !== entry.reqBody)))
        ? `\n\nNote: credentials were masked${carried.length ? ` (${carried.join(", ")})` : ""}, so this will not reproduce the call as is. Pass reveal_values=true for the real values.` : "";
    return { content: [{ type: "text", text: `# ${entry.method} ${entry.status} — captured id=${entry.id}\n${parts.join(" \\\n")}${warn}` }] };
  });
