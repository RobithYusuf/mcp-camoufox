// Probe what widget DOM looks like on nopecha Turnstile demo
import { Camoufox } from "camoufox-js";

const ctx = await Camoufox({ headless: false, humanize: false, disable_coop: true, window: [1280, 800], i_know_what_im_doing: true });
const page = await ctx.newPage();
await page.goto("https://nopecha.com/demo/turnstile", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);

const info = await page.evaluate(() => {
  const out = { iframes: [], cfDivs: [], dataAttrs: [], widgets: [] };
  document.querySelectorAll("iframe").forEach(f => out.iframes.push({ src: f.src.slice(0, 100), id: f.id, name: f.name, w: f.offsetWidth, h: f.offsetHeight }));
  document.querySelectorAll('[class*="cf"], [class*="turnstile"], [id*="cf"], [id*="turnstile"]').forEach(e => out.cfDivs.push({ tag: e.tagName, id: e.id, cls: e.className, w: e.offsetWidth, h: e.offsetHeight }));
  document.querySelectorAll('[data-sitekey], [data-testid*="challenge"], [data-testid*="turnstile"]').forEach(e => out.dataAttrs.push({ tag: e.tagName, data: Object.fromEntries(Object.entries(e.dataset)), w: e.offsetWidth, h: e.offsetHeight }));
  // Find ANY div sized like a Turnstile widget (300x65 typical)
  document.querySelectorAll("div").forEach(d => {
    if (d.offsetWidth >= 280 && d.offsetWidth <= 320 && d.offsetHeight >= 60 && d.offsetHeight <= 90) {
      out.widgets.push({ id: d.id, cls: d.className, w: d.offsetWidth, h: d.offsetHeight, text: d.innerText?.slice(0, 40) });
    }
  });
  return out;
});

console.log(JSON.stringify(info, null, 2));
await ctx.close();
