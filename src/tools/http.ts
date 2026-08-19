// The browserless HTTP kit: TLS-impersonating fetch (impit) and HTML -> markdown.
//
// Registered by importing this module — see src/index.ts.
import { z } from "zod";
import type { BrowserContext, Page, Dialog } from "playwright-core";
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "fs";
import { S, getPage } from "../state.js";
import { PKG_VERSION, ACTION_TIMEOUT, jsStr, safeName, writeSecretFile, expandHome, resolveOutPath,
         ERROR_HOOK_JS, totpFromSecret, clickWithFallback, clickNote, fillLocator, refLocator,
         scopeRoot, describeMatches, candidateList, SNAPSHOT_JS, formatSnapshot, snapshotPage,
         trackPage, inflightOf, type ClickMode } from "../helpers.js";
import { regTool } from "../server.js";

// ═══════════════════════════════════════════════════════════════════════════

type Impersonate = "firefox" | "chrome";

// impit is a native module; load it lazily so a platform without prebuilt
// bindings still gets a working server (only these tools degrade).
let impitMod: any = null;
async function getImpit(impersonate: Impersonate, proxy?: string, timeoutMs = 30000, followRedirects = true): Promise<any> {
  if (!impitMod) {
    try { impitMod = await import("impit"); }
    catch (e: any) {
      throw new Error(`impit (native HTTP client) unavailable on this platform: ${e?.message || e}. Use the browser tools instead (navigate + scrape_page).`);
    }
  }
  const opts: any = { browser: impersonate, timeout: timeoutMs, followRedirects };
  if (proxy) opts.proxyUrl = proxy;
  return new impitMod.Impit(opts);
}

// Cookies the live browser session would send for this URL — lets an HTTP call
// ride a session established by a real login.
async function cookieHeaderFor(url: string): Promise<string> {
  if (!S.browserContext) return "";
  try {
    const cookies = await S.browserContext.cookies(url);
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
}): Promise<{ status: number | null; text: string; headers: Record<string, string>; url: string; error?: string; redirects?: string[] }> {
  // Redirects are followed MANUALLY. impit replays a manually-set Cookie header
  // onto whatever host a redirect points at, so a request to a victim endpoint
  // with an open redirect handed the victim's session cookie to the attacker
  // host (reproduced). Following by hand lets us recompute cookies per hop and
  // drop credential headers the moment the origin changes.
  const MAX_HOPS = 5;
  const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
  const callerHeaders: Record<string, string> = { ...(opts.headers || {}) };
  let url = opts.url;
  let method = (opts.method || "GET").toUpperCase();
  let body = opts.body;
  const trail: string[] = [];
  try {
    const client = await getImpit(opts.impersonate || "firefox", opts.proxy, opts.timeoutMs || 30000, false);
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const headers: Record<string, string> = { ...callerHeaders };
      const callerSetCookie = Object.keys(callerHeaders).some(k => k.toLowerCase() === "cookie");
      if (opts.useBrowserCookies !== false && !callerSetCookie) {
        for (const k of Object.keys(headers)) if (k.toLowerCase() === "cookie") delete headers[k];
        const ck = await cookieHeaderFor(url);            // cookies for THIS hop only
        if (ck) headers["Cookie"] = ck;
      }
      const res = await client.fetch(url, { method, headers, ...(body ? { body } : {}) });
      const hdrs: Record<string, string> = {};
      try { for (const [k, v] of (res.headers as any).entries()) hdrs[k] = String(v); } catch {}

      if (REDIRECT_CODES.has(res.status) && hop < MAX_HOPS) {
        const loc = hdrs["location"] || hdrs["Location"];
        if (!loc) return { status: res.status, text: await res.text().catch(() => ""), headers: hdrs, url, redirects: trail };
        let next: string;
        try { next = new URL(loc, url).toString(); }
        catch { return { status: res.status, text: "", headers: hdrs, url, error: `bad Location header: ${loc}`, redirects: trail }; }
        let sameOrigin = false;
        try { sameOrigin = new URL(next).origin === new URL(url).origin; } catch {}
        if (!sameOrigin) {
          for (const k of Object.keys(callerHeaders)) {
            if (/^(cookie|authorization|proxy-authorization)$/i.test(k)) delete callerHeaders[k];
          }
        }
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
          method = "GET"; body = undefined;
        }
        trail.push(`${res.status} -> ${next}${sameOrigin ? "" : " (cross-origin: credentials dropped)"}`);
        url = next;
        continue;
      }
      return { status: res.status, text: await res.text().catch(() => ""), headers: hdrs, url: res.url || url, redirects: trail };
    }
    return { status: null, text: "", headers: {}, url, error: `too many redirects (>${MAX_HOPS})`, redirects: trail };
  } catch (e: any) {
    return { status: null, text: "", headers: {}, url, error: String(e?.message || e), redirects: trail };
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
        `cookies sent: ${use_browser_cookies ? "browser session (recomputed per redirect hop)" : "none"}  impersonate: ${impersonate}\n` +
        (r.redirects && r.redirects.length ? `redirects: ${r.redirects.join(" | ")}\n` : "") +
        `\n── headers ──\n${hdrLines}\n\n── body ──\n${shown}` }],
    };
  });

regTool("http_session_cookies",
  "Show which browser cookies would be sent with an HTTP request to this URL. Use it to confirm session sharing before relying on http_request.",
  { url: z.string() },
  async ({ url }) => {
    if (!S.browserContext) throw new Error("Browser not running. Call browser_launch first.");
    const cookies = await S.browserContext.cookies(url);
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
    if (!S.browserUp || S.pages.length === 0) {
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
