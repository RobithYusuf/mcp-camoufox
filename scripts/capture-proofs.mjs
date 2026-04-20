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
    waitMs: 3000,
    after: async (page) => {
      const frame = page.frames().find(f => f.url().includes("challenges.cloudflare.com"));
      if (frame) {
        try { await frame.locator("input[type=checkbox]").click({ timeout: 8000 }); } catch {}
      }
      await page.waitForTimeout(6000);
    },
  },
  {
    name: "nowsecure",
    url: "https://nowsecure.nl/",
    waitSel: "body",
    waitMs: 3000,
    after: async (page) => {
      try { await page.waitForSelector("h1", { timeout: 15000 }); } catch {}
      await page.waitForTimeout(5000);
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
