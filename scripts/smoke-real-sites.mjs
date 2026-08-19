#!/usr/bin/env node
// Drive the real web, not a fixture.
//
// This exists because three separate bugs shipped while 97 local checks passed:
// waitForFunction's eval() died on every strict CSP, browser_launch produced a
// viewport that no real window could have, and detect_content_pattern threw on
// any page containing an inline SVG. No fixture had a CSP header, a real window
// manager, or an SVG. Each one was found by a human asking to try a real site.
//
// Not part of `npm test`: the open web is not deterministic and must never be a
// gate that fails for someone else's outage. Run it before publishing.
//
//   npm run smoke:real
import { startServer } from "./test/harness.mjs";

const results = [];
const check = async (name, fn) => {
  const t0 = Date.now();
  try {
    const [ok, detail] = await fn();
    results.push({ name, ok, detail: String(detail ?? "").replace(/\s+/g, " ").slice(0, 96), ms: Date.now() - t0 });
  } catch (e) {
    results.push({ name, ok: false, detail: "THREW: " + String(e?.message || e).replace(/\s+/g, " ").slice(0, 96), ms: Date.now() - t0 });
  }
};

const S = await startServer();
const c = S.call;
try {
  await c("browser_launch", { headless: true, fresh_profile: true, width: 1400, height: 900 });

  await check("strict CSP: github.com navigates", async () => {
    const t = await c("navigate", { url: "https://github.com" });
    return [!t.startsWith("IS_ERROR") && /github/i.test(t), t.split("\n")[0]];
  });
  await check("strict CSP: MDN navigates and renders", async () => {
    await c("navigate", { url: "https://developer.mozilla.org/en-US/" });
    const h = await c("evaluate", { expression: "String(document.querySelectorAll('a').length)" });
    return [Number(h) > 20, `${h} links`];
  });
  await check("launch geometry is physically possible", async () => {
    const g = JSON.parse(await c("evaluate", { expression:
      "JSON.stringify({ iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight })" }));
    return [g.ow - g.iw === 0 && g.oh - g.ih > 0 && g.oh - g.ih <= 120, `outer ${g.ow}x${g.oh} inner ${g.iw}x${g.ih}`];
  });
  await check("fingerprint_audit reports no contradiction", async () => {
    const t = await c("fingerprint_audit");
    const flags = t.split("\n").filter(l => l.trim().startsWith("•"));
    return [t.includes("No internal contradictions"), flags.join(" ") || "clean"];
  });
  await check("inline SVG: detect_content_pattern on a news site", async () => {
    await c("navigate", { url: "https://techcrunch.com/category/artificial-intelligence/" });
    const t = await c("detect_content_pattern", { min_items: 8 });
    return [!t.startsWith("IS_ERROR") && /pattern/i.test(t), t.split("\n")[0]];
  });
  await check("extract_structured pulls real headlines with links", async () => {
    const raw = await c("extract_structured", {
      container_selector: "div.loop-card",
      fields: [{ name: "title", selector: "a.loop-card__title-link" },
               { name: "url", selector: "a.loop-card__title-link", attribute: "href" }],
      limit: 5,
    });
    // Slice to the LAST bracket, not the first: the reply can carry a trailing
    // note after the array, and a naive slice made this fail as a JSON error
    // rather than telling us anything about the page.
    const rows = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
    return [rows.length >= 3 && rows.every(r => /^https?:/.test(r.url) && r.title.length > 10), `${rows.length} items`];
  });
  await check("navigation survives past the 5th tab on real sites", async () => {
    const sites = ["https://example.com", "https://en.wikipedia.org/wiki/Firefox", "https://www.npmjs.com",
                   "https://news.ycombinator.com", "https://developer.mozilla.org/en-US/", "https://example.org"];
    const bad = [];
    for (const u of sites) {
      const r = await c("tab_new", { url: u });
      if (r.startsWith("IS_ERROR")) bad.push(new URL(u).hostname);
    }
    const nav = await c("navigate", { url: "https://example.com" });
    for (const u of sites) { try { await c("tab_close", { url_contains: new URL(u).hostname }); } catch {} }
    return [!bad.length && !nav.startsWith("IS_ERROR"), bad.length ? `failed: ${bad.join(",")}` : "6 tabs + navigate OK"];
  });
  await check("interception cuts real bytes without breaking the page", async () => {
    const bytesOf = async () => Number(await c("evaluate", { expression:
      "String(performance.getEntriesByType('resource').reduce(function(a,r){return a+(r.transferSize||0)},0))" }));
    await c("navigate", { url: "https://www.bbc.com/news" });
    const before = await bytesOf();
    await c("intercept_start", { block_types: ["image", "media", "font", "stylesheet"] });
    await c("navigate", { url: "https://www.bbc.com/news" });
    const after = await bytesOf();
    const heads = Number(await c("evaluate", { expression: "String(document.querySelectorAll('h2,h3').length)" }));
    await c("intercept_stop");
    return [after < before / 2 && heads > 10, `${(before/1024).toFixed(0)}KB → ${(after/1024).toFixed(0)}KB, ${heads} headings`];
  });
  await check("browserless path works without a browser", async () => {
    const t = await c("scrape_markdown", { url: "https://example.com", max_chars: 400 });
    return [t.includes("status: 200") && /example/i.test(t), t.split("\n")[0]];
  });
} finally {
  try { await c("browser_close"); } catch {}
  S.kill();
}

const pass = results.filter(r => r.ok).length;
console.log(`\n${"=".repeat(92)}\nreal-site smoke`);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(52)} ${String(r.ms).padStart(6)}ms  ${r.detail}`);
console.log(`${"=".repeat(92)}\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
