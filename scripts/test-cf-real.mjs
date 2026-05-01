// Test click_turnstile with EXPANDED selector set to handle nopecha page.
import { Camoufox } from "camoufox-js";

const URL = process.argv[2] || "https://nopecha.com/demo/turnstile";

const ctx = await Camoufox({
  headless: false,
  humanize: true,
  disable_coop: true,
  window: [1280, 800],
  i_know_what_im_doing: true,
});
const page = await ctx.newPage();
console.log("[*] navigating to", URL);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(4000);

const t0 = Date.now();

const coords = await page.evaluate(() => {
  // Try widget container selectors (ordered from most specific to most generic)
  const sels = [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="turnstile"]',
    '[data-testid*="challenge-widget"]',
    '[data-testid*="turnstile"]',
    '[data-sitekey]',
    '.cf-turnstile',
    '.turnstile',                // nopecha uses bare .turnstile
  ];
  for (const sel of sels) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width >= 280 && r.width <= 400 && r.height >= 60 && r.height <= 100) {
        return { found: sel, left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      }
    }
  }
  // Fallback: find visible parent of cf-*_response input
  for (const input of document.querySelectorAll('input[id^="cf-chl-widget-"]')) {
    let p = input.parentElement;
    while (p) {
      const r = p.getBoundingClientRect();
      if (r.width >= 280 && r.width <= 400 && r.height >= 60 && r.height <= 100) {
        return { found: 'response-input-parent', left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      }
      p = p.parentElement;
    }
  }
  return null;
});

console.log("[*] widget:", coords);
if (!coords) {
  await page.screenshot({ path: "/Users/macbook/.camoufox-mcp/screenshots/cf-nowidget.png" });
  await ctx.close();
  process.exit(1);
}

const targetX = coords.left + 30, targetY = coords.top + Math.floor(coords.height / 2);
await page.mouse.move(targetX + 180, targetY - 80, { steps: 15 });
await page.waitForTimeout(150);
await page.mouse.click(targetX, targetY);
const t1 = Date.now();
console.log(`[*] tool logic: ${t1 - t0}ms, clicked (${targetX},${targetY})`);

let verified = false;
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => {
    const input = document.querySelector('input[id^="cf-chl-widget-"]');
    const body = document.body.innerText;
    return { hasSuccess: body.includes("Success"), tokenSet: !!(input && input.value && input.value.length > 50) };
  });
  if (state.tokenSet || state.hasSuccess) { verified = true; console.log(`[*] verified after ${Date.now() - t1}ms (success=${state.hasSuccess}, token=${state.tokenSet})`); break; }
}

await page.screenshot({ path: "/Users/macbook/.camoufox-mcp/screenshots/cf-demo-result.png" });
console.log(`[ok] result: ${verified ? "PASS ✅" : "FAIL ❌"}  total: ${Date.now() - t0}ms`);
await ctx.close();
