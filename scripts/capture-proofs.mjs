// Capture proof screenshots via Camoufox directly (no MCP layer).
// Run: node scripts/capture-proofs.mjs
// Output: ~/.camoufox-mcp/screenshots/proof-<name>.png (raw), then compress separately.

import { Camoufox } from "camoufox-js";
import { mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const OUT = join(homedir(), ".camoufox-mcp", "screenshots");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const SITES = [
  { name: "sannysoft",  url: "https://bot.sannysoft.com",                         waitSel: "body", waitMs: 3500 },
  { name: "browserscan", url: "https://www.browserscan.net/bot-detection",        waitSel: "body", waitMs: 5000 },
  {
    name: "turnstile",
    url: "https://2captcha.com/demo/cloudflare-turnstile",
    waitSel: "body",
    waitMs: 8000,
    after: async (page) => {
      // Camoufox widget is accessible via .cf-turnstile div (no iframe in DOM).
      // Click at widget checkbox position (30px from left, vertical center).
      const widget = await page.$(".cf-turnstile, [data-sitekey]");
      if (!widget) return;
      const b = await widget.boundingBox();
      const cx = b.x + 30, cy = b.y + b.height / 2;
      await page.mouse.move(cx - 100, cy - 60, { steps: 12 });
      await page.waitForTimeout(300);
      await page.mouse.move(cx, cy, { steps: 8 });
      await page.waitForTimeout(150);
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(10000);
    },
  },
];

const ctx = await Camoufox({
  headless: false,
  humanize: true,
  window: [1280, 800],
  i_know_what_im_doing: true,
});

const page = typeof ctx.pages === "function" ? (ctx.pages()[0] ?? await ctx.newPage()) : await ctx.newPage();

for (const s of SITES) {
  console.log(`[*] ${s.name} -> ${s.url}`);
  await page.goto(s.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  try { await page.waitForSelector(s.waitSel, { timeout: 10000 }); } catch {}
  await page.waitForTimeout(s.waitMs);
  if (s.after) { try { await s.after(page); } catch (e) { console.log("    after-err:", e.message); } }
  const path = join(OUT, `proof-${s.name}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`    saved ${path}`);
}

await ctx.close();
console.log("[ok] all proofs captured");
