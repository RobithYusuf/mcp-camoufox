#!/usr/bin/env node
/**
 * MCP Camoufox — Stealth browser automation MCP server.
 *
 * Chrome DevTools MCP-level power with Camoufox anti-detection.
 * 39 tools: navigate, click, fill, type, screenshot, snapshot, tabs,
 * cookies, JS eval, scroll, keyboard, dialog, file upload, network/console.
 *
 * Install:  npm install -g mcp-camoufox
 * Usage:    claude mcp add camoufox -- npx -y mcp-camoufox
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Camoufox } from "camoufox-js";
import type { BrowserContext, Page, Dialog } from "playwright-core";

// ── Global State ───────────────────────────────────────────────────────────

const PROFILE_DIR = `${process.env.HOME || process.env.USERPROFILE}/.camoufox-mcp/profile`;
const SCREENSHOT_DIR = `${process.env.HOME || process.env.USERPROFILE}/.camoufox-mcp/screenshots`;

let browserContext: BrowserContext | null = null;
let pages: Page[] = [];
let activePage = 0;
let browserUp = false;

function getPage(): Page {
  if (!browserUp || pages.length === 0) {
    throw new Error("Browser not running. Call browser_launch first.");
  }
  if (activePage >= pages.length) activePage = 0;
  return pages[activePage];
}

// ── Helpers ────────────────────────────────────────────────────────────────

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

function ensureDirs() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// DOM snapshot JS — IIFE so page.evaluate runs it immediately
const SNAPSHOT_JS = `(() => {
  var sels = 'button, a, input:not([type="hidden"]), textarea, select, '
    + '[role="button"], [role="link"], [role="textbox"], [role="checkbox"], '
    + '[role="radio"], [role="tab"], [role="menuitem"], [contenteditable="true"], '
    + 'img[alt], h1, h2, h3, h4, h5, h6, label, [role="dialog"], [role="alert"], [role="status"]';
  var els = document.querySelectorAll(sels);
  var results = [];
  var refId = 0;
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    var ref = 'e' + refId++;
    el.setAttribute('data-mcp-ref', ref);
    var entry = {
      ref: ref,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      text: (el.innerText || el.value || '').trim().slice(0, 100),
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      placeholder: el.getAttribute('placeholder') || '',
      aria: el.getAttribute('aria-label') || '',
      href: el.tagName === 'A' ? (el.href || '').slice(0, 500) : '',
      checked: el.checked || false,
      disabled: el.disabled || false,
    };
    var clean = {};
    var keys = Object.keys(entry);
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j], v = entry[k];
      if (v !== '' && v !== false && v !== undefined) clean[k] = v;
    }
    results.push(clean);
  }
  return results;
})()`;

function formatSnapshot(elements: any[], url: string, title: string): string {
  if (!elements || !Array.isArray(elements)) elements = [];
  const lines = [
    `Page: ${title}`,
    `URL: ${url}`,
    "",
    `Interactive elements (${elements.length}):`,
    "",
  ];
  for (const el of elements) {
    const parts = [`[${el.tag || "?"}]`];
    if (el.role) parts.push(`role=${el.role}`);
    if (el.type) parts.push(`type=${el.type}`);
    if (el.text) parts.push(`"${el.text.slice(0, 80)}"`);
    if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
    if (el.aria) parts.push(`aria="${el.aria}"`);
    if (el.href) parts.push(`href="${el.href.slice(0, 60)}"`);
    if (el.checked) parts.push("checked");
    if (el.disabled) parts.push("disabled");
    lines.push(`  ref=${el.ref}  ${parts.join(" ")}`);
  }
  return lines.join("\n");
}

// ── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "camoufox-browser",
  version: "0.2.0",
});

// ── Tools: Browser Lifecycle ───────────────────────────────────────────────

server.tool(
  "browser_launch",
  "Launch Camoufox stealth browser and navigate to URL. Browser persists between calls. Call this first.",
  {
    url: z.string().default("about:blank").describe("URL to navigate to"),
    headless: z.boolean().default(true).describe("Run without visible window"),
    humanize: z.boolean().default(false).describe("Human-like mouse movements"),
    geoip: z.boolean().default(true).describe("Auto-detect timezone from IP"),
    locale: z.string().default("en-US").describe("Browser locale"),
    width: z.number().default(0).describe("Window width (0 = default 1280)"),
    height: z.number().default(0).describe("Window height (0 = default 800)"),
  },
  async ({ url, headless, humanize, geoip, locale, width, height }) => {
    if (browserUp && browserContext) {
      const page = getPage();
      if (url && url !== "about:blank") {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(1500);
      }
      return { content: [{ type: "text", text: `Already running. Navigated to: ${page.url()}` }] };
    }

    ensureDirs();
    const w = width > 0 ? width : 1280;
    const h = height > 0 ? height : 800;

    // Auto-download Camoufox binary if not installed
    // camoufox-js does NOT auto-download — we handle it here
    await (async () => {
      const { execSync } = await import("child_process");
      const { existsSync, readdirSync } = await import("fs");
      const { join: pathJoin } = await import("path");
      const os = await import("os");

      // Detect cache dir per platform (same logic as camoufox-js pkgman.ts)
      const homeDir = os.homedir();
      const platform = os.platform();
      let cacheDir: string;
      if (platform === "darwin") {
        cacheDir = pathJoin(homeDir, "Library", "Caches", "camoufox");
      } else if (platform === "win32") {
        cacheDir = pathJoin(process.env.LOCALAPPDATA || pathJoin(homeDir, "AppData", "Local"), "camoufox");
      } else {
        cacheDir = pathJoin(process.env.XDG_CACHE_HOME || pathJoin(homeDir, ".cache"), "camoufox");
      }

      // Check if binary exists (look for version.json inside cache dir)
      const versionFile = pathJoin(cacheDir, "version.json");
      const isInstalled = existsSync(versionFile);

      if (!isInstalled) {
        console.error("");
        console.error("=".repeat(60));
        console.error("[mcp-camoufox] First-time setup: downloading Camoufox browser");
        console.error("[mcp-camoufox] This is ~500MB and only happens once.");
        console.error("[mcp-camoufox] Please wait 2-5 minutes...");
        console.error("=".repeat(60));
        console.error("");
        try {
          // Use npx to run camoufox-js CLI fetch command
          const cmd = platform === "win32" ? "npx.cmd" : "npx";
          execSync(`${cmd} camoufox-js fetch`, {
            stdio: "inherit",
            timeout: 900000, // 15 min max
            env: { ...process.env, npm_config_yes: "true" },
          });
          console.error("");
          console.error("[mcp-camoufox] Download complete! Browser ready.");
          console.error("");
        } catch (fetchErr: any) {
          console.error(`[mcp-camoufox] Auto-download failed: ${fetchErr.message?.slice(0, 200)}`);
          console.error("[mcp-camoufox] Try manually: npx camoufox-js fetch");
          throw new Error(
            "Camoufox browser binary not found. Auto-download failed. " +
            "Please run manually: npx camoufox-js fetch"
          );
        }
      }
    })();

    const ctx = await Camoufox({
      headless,
      humanize,
      geoip,
      locale,
      user_data_dir: PROFILE_DIR,
      disable_coop: true,
      window: [w, h] as [number, number],
      i_know_what_im_doing: true,
      firefox_user_prefs: {
        "permissions.default.desktop-notification": 2,
        "dom.webnotifications.enabled": false,
        "browser.translations.automaticallyPopup": false,
      },
    }) as BrowserContext;

    browserContext = ctx;
    const existingPages = ctx.pages();
    const page = existingPages.length > 0 ? existingPages[0] : await ctx.newPage();
    pages = [page];
    activePage = 0;
    browserUp = true;

    if (url && url !== "about:blank") {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(1500);
    }
    const title = await page.title();
    return { content: [{ type: "text", text: `Browser launched. URL: ${page.url()}\nTitle: ${title}` }] };
  }
);

server.tool(
  "browser_close",
  "Close the browser. Cookies are preserved in profile.",
  {},
  async () => {
    if (browserContext) {
      try { await browserContext.close(); } catch {}
    }
    browserContext = null;
    pages = [];
    activePage = 0;
    browserUp = false;
    return { content: [{ type: "text", text: "Browser closed. Profile saved." }] };
  }
);

// ── Tools: Navigation ──────────────────────────────────────────────────────

server.tool(
  "navigate",
  "Navigate to a URL.",
  {
    url: z.string().describe("URL to navigate to"),
    wait_until: z.enum(["domcontentloaded", "load", "networkidle"]).default("domcontentloaded"),
    timeout: z.number().default(30000),
  },
  async ({ url, wait_until, timeout }) => {
    const page = getPage();
    await page.goto(url, { waitUntil: wait_until, timeout });
    await page.waitForTimeout(1000);
    return { content: [{ type: "text", text: `Navigated to: ${page.url()}\nTitle: ${await page.title()}` }] };
  }
);

server.tool("go_back", "Navigate back in history.", {}, async () => {
  const page = getPage();
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 });
  return { content: [{ type: "text", text: `Went back. URL: ${page.url()}` }] };
});

server.tool("go_forward", "Navigate forward in history.", {}, async () => {
  const page = getPage();
  await page.goForward({ waitUntil: "domcontentloaded", timeout: 15000 });
  return { content: [{ type: "text", text: `Went forward. URL: ${page.url()}` }] };
});

server.tool("reload", "Reload the current page.", {}, async () => {
  const page = getPage();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
  return { content: [{ type: "text", text: `Reloaded. URL: ${page.url()}` }] };
});

// ── Tools: Snapshot & Screenshot ───────────────────────────────────────────

server.tool(
  "browser_snapshot",
  "Get visible interactive elements with ref IDs. Use refs with click/fill. Always call after navigation.",
  {},
  async () => {
    const page = getPage();
    const elements = await page.evaluate(SNAPSHOT_JS) || [];
    const text = formatSnapshot(elements as any[], page.url(), await page.title());
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "screenshot",
  "Take a screenshot of the current page.",
  {
    name: z.string().default("page").describe("Filename prefix"),
    full_page: z.boolean().default(false).describe("Full scrollable page"),
  },
  async ({ name, full_page }) => {
    const page = getPage();
    const path = join(SCREENSHOT_DIR, `${name}.png`);
    await page.screenshot({ path, fullPage: full_page });
    return { content: [{ type: "text", text: `Screenshot saved: ${path}\nURL: ${page.url()}` }] };
  }
);

// ── Tools: Element Interaction ─────────────────────────────────────────────

server.tool(
  "click",
  "Click element by ref ID from browser_snapshot. Auto JS-fallback for overlays.",
  {
    ref: z.string().describe("Element ref (e.g. 'e5')"),
    button: z.enum(["left", "right", "middle"]).default("left"),
    dblclick: z.boolean().default(false),
  },
  async ({ ref, button, dblclick }) => {
    const page = getPage();
    const loc = page.locator(`[data-mcp-ref="${ref}"]`).first();
    try {
      if (dblclick) await loc.dblclick({ button, timeout: 5000 });
      else await loc.click({ button, timeout: 5000 });
    } catch {
      await loc.evaluate((el: any) => el.click());
    }
    await page.waitForTimeout(1000);
    return { content: [{ type: "text", text: `Clicked ref=${ref}. URL: ${page.url()}` }] };
  }
);

server.tool(
  "click_text",
  "Click element by visible text.",
  {
    text: z.string().describe("Visible text"),
    exact: z.boolean().default(true),
  },
  async ({ text, exact }) => {
    const page = getPage();
    const loc = page.getByText(text, { exact }).first();
    try { await loc.click({ timeout: 5000 }); }
    catch { await loc.evaluate((el: any) => el.click()); }
    await page.waitForTimeout(1000);
    return { content: [{ type: "text", text: `Clicked text='${text}'. URL: ${page.url()}` }] };
  }
);

server.tool(
  "click_role",
  "Click element by ARIA role and name.",
  {
    role: z.string().describe("ARIA role (button, link, textbox, etc.)"),
    name: z.string().default("").describe("Accessible name"),
  },
  async ({ role, name: ariaName }) => {
    const page = getPage();
    const loc = ariaName
      ? page.getByRole(role as any, { name: ariaName, exact: true }).first()
      : page.getByRole(role as any).first();
    try { await loc.click({ timeout: 5000 }); }
    catch { await loc.evaluate((el: any) => el.click()); }
    await page.waitForTimeout(1000);
    return { content: [{ type: "text", text: `Clicked role=${role} name='${ariaName}'. URL: ${page.url()}` }] };
  }
);

server.tool("hover", "Hover over element by ref ID.", {
  ref: z.string(),
}, async ({ ref }) => {
  const page = getPage();
  await page.locator(`[data-mcp-ref="${ref}"]`).first().hover({ timeout: 5000 });
  return { content: [{ type: "text", text: `Hovered ref=${ref}` }] };
});

server.tool("fill", "Fill input/textarea by ref ID. Clears existing content.", {
  ref: z.string().describe("Element ref"),
  value: z.string().describe("Text to fill"),
}, async ({ ref, value }) => {
  const page = getPage();
  await page.locator(`[data-mcp-ref="${ref}"]`).first().fill(value, { timeout: 5000 });
  return { content: [{ type: "text", text: `Filled ref=${ref} with '${value.slice(0, 50)}'` }] };
});

server.tool("select_option", "Select option from <select> dropdown.", {
  ref: z.string(), value: z.string(),
}, async ({ ref, value }) => {
  const page = getPage();
  await page.locator(`[data-mcp-ref="${ref}"]`).first().selectOption(value, { timeout: 5000 });
  return { content: [{ type: "text", text: `Selected '${value}' in ref=${ref}` }] };
});

server.tool("check", "Check checkbox or radio button.", { ref: z.string() }, async ({ ref }) => {
  const page = getPage();
  await page.locator(`[data-mcp-ref="${ref}"]`).first().check({ timeout: 5000 });
  return { content: [{ type: "text", text: `Checked ref=${ref}` }] };
});

server.tool("uncheck", "Uncheck a checkbox.", { ref: z.string() }, async ({ ref }) => {
  const page = getPage();
  await page.locator(`[data-mcp-ref="${ref}"]`).first().uncheck({ timeout: 5000 });
  return { content: [{ type: "text", text: `Unchecked ref=${ref}` }] };
});

// ── Tools: Keyboard ────────────────────────────────────────────────────────

server.tool("type_text", "Type text char by char via keyboard.", {
  text: z.string(),
  delay: z.number().default(50).describe("Delay between keys (ms)"),
}, async ({ text, delay }) => {
  const page = getPage();
  await page.keyboard.type(text, { delay });
  return { content: [{ type: "text", text: `Typed: '${text.slice(0, 50)}'` }] };
});

server.tool("press_key", "Press key or combo (Enter, Escape, Control+a, etc.).", {
  key: z.string().describe("Key name"),
}, async ({ key }) => {
  const page = getPage();
  await page.keyboard.press(key);
  await page.waitForTimeout(300);
  return { content: [{ type: "text", text: `Pressed: ${key}` }] };
});

// ── Tools: Wait ────────────────────────────────────────────────────────────

server.tool("wait_for", "Wait for element/text to appear or disappear.", {
  selector: z.string().default("").describe("CSS selector"),
  text: z.string().default("").describe("Text to wait for"),
  state: z.enum(["visible", "hidden", "attached", "detached"]).default("visible"),
  timeout: z.number().default(10000),
}, async ({ selector, text, state, timeout }) => {
  const page = getPage();
  if (selector) {
    await page.locator(selector).first().waitFor({ state, timeout });
    return { content: [{ type: "text", text: `Selector '${selector}' is now ${state}` }] };
  } else if (text) {
    await page.getByText(text).first().waitFor({ state, timeout });
    return { content: [{ type: "text", text: `Text '${text}' is now ${state}` }] };
  }
  await page.waitForTimeout(timeout);
  return { content: [{ type: "text", text: `Waited ${timeout}ms` }] };
});

server.tool("wait_for_navigation", "Wait for page load to complete.", {
  timeout: z.number().default(15000),
}, async ({ timeout }) => {
  const page = getPage();
  await page.waitForLoadState("domcontentloaded", { timeout });
  return { content: [{ type: "text", text: `Navigation complete. URL: ${page.url()}` }] };
});

// ── Tools: JavaScript ──────────────────────────────────────────────────────

server.tool("evaluate", "Execute JavaScript in page context.", {
  expression: z.string().describe("JS expression"),
}, async ({ expression }) => {
  const page = getPage();
  const result = await page.evaluate(expression);
  const text = typeof result === "object" ? JSON.stringify(result, null, 2) : String(result);
  return { content: [{ type: "text", text }] };
});

// ── Tools: Page Info ───────────────────────────────────────────────────────

server.tool("get_url", "Get current URL and title.", {}, async () => {
  const page = getPage();
  return { content: [{ type: "text", text: `URL: ${page.url()}\nTitle: ${await page.title()}` }] };
});

server.tool("get_text", "Get visible text from page or element.", {
  selector: z.string().default("body"),
}, async ({ selector }) => {
  const page = getPage();
  let text = await page.locator(selector).first().innerText({ timeout: 5000 });
  if (text.length > 5000) text = text.slice(0, 5000) + `\n... (truncated, ${text.length} chars)`;
  return { content: [{ type: "text", text }] };
});

server.tool("get_html", "Get HTML content from page or element.", {
  selector: z.string().default("body"),
  outer: z.boolean().default(false),
}, async ({ selector, outer }) => {
  const page = getPage();
  const loc = page.locator(selector).first();
  let html = outer
    ? await loc.evaluate((el: any) => el.outerHTML)
    : await loc.innerHTML({ timeout: 5000 });
  if (html.length > 10000) html = html.slice(0, 10000) + `\n<!-- truncated -->`;
  return { content: [{ type: "text", text: html }] };
});

// ── Tools: Tab Management ──────────────────────────────────────────────────

server.tool("tab_list", "List all open tabs.", {}, async () => {
  const lines: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const a = i === activePage ? " (active)" : "";
    let title = "(closed)";
    try { title = await pages[i].title(); } catch {}
    lines.push(`  [${i}]${a} ${pages[i].url()} — ${title}`);
  }
  return { content: [{ type: "text", text: `Tabs (${pages.length}):\n${lines.join("\n")}` }] };
});

server.tool("tab_new", "Open new tab.", {
  url: z.string().default("about:blank"),
}, async ({ url }) => {
  if (!browserContext) throw new Error("Browser not running.");
  const page = await browserContext.newPage();
  if (url && url !== "about:blank") {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  }
  pages.push(page);
  activePage = pages.length - 1;
  return { content: [{ type: "text", text: `New tab [${activePage}]. URL: ${page.url()}` }] };
});

server.tool("tab_select", "Switch to tab by index.", {
  index: z.number(),
}, async ({ index }) => {
  if (index < 0 || index >= pages.length) {
    return { content: [{ type: "text", text: `Invalid index ${index}. Have ${pages.length} tabs.` }] };
  }
  activePage = index;
  try { await pages[index].bringToFront(); } catch {}
  return { content: [{ type: "text", text: `Switched to tab [${index}]. URL: ${pages[index].url()}` }] };
});

server.tool("tab_close", "Close a tab (-1 = active).", {
  index: z.number().default(-1),
}, async ({ index }) => {
  const idx = index === -1 ? activePage : index;
  if (idx < 0 || idx >= pages.length) {
    return { content: [{ type: "text", text: `Invalid index.` }] };
  }
  const page = pages.splice(idx, 1)[0];
  try { await page.close(); } catch {}
  if (pages.length === 0) {
    activePage = 0;
    return { content: [{ type: "text", text: "Last tab closed." }] };
  }
  activePage = Math.min(activePage, pages.length - 1);
  return { content: [{ type: "text", text: `Closed tab [${idx}]. Active: [${activePage}]` }] };
});

// ── Tools: Cookies ─────────────────────────────────────────────────────────

server.tool("cookie_list", "List cookies.", {
  domain: z.string().default(""),
}, async ({ domain }) => {
  if (!browserContext) throw new Error("Browser not running.");
  let cookies = await browserContext.cookies();
  if (domain) cookies = cookies.filter(c => c.domain.includes(domain));
  const lines = cookies.slice(0, 50).map(c => `  ${c.name}=${String(c.value).slice(0, 40)}  domain=${c.domain}`);
  return { content: [{ type: "text", text: lines.length ? `Cookies (${cookies.length}):\n${lines.join("\n")}` : "No cookies." }] };
});

server.tool("cookie_set", "Set a cookie.", {
  name: z.string(), value: z.string(), domain: z.string(), path: z.string().default("/"),
}, async ({ name, value, domain, path }) => {
  if (!browserContext) throw new Error("Browser not running.");
  await browserContext.addCookies([{ name, value, domain, path, url: undefined as any }]);
  return { content: [{ type: "text", text: `Cookie set: ${name}=${value.slice(0, 40)} domain=${domain}` }] };
});

server.tool("cookie_delete", "Delete cookies. Both empty = clear all.", {
  name: z.string().default(""), domain: z.string().default(""),
}, async ({ name, domain }) => {
  if (!browserContext) throw new Error("Browser not running.");
  if (!name && !domain) {
    await browserContext.clearCookies();
    return { content: [{ type: "text", text: "All cookies cleared." }] };
  }
  const cookies = await browserContext.cookies();
  const toKeep = cookies.filter(c => {
    const matchN = !name || c.name === name;
    const matchD = !domain || c.domain.includes(domain);
    return !(matchN && matchD);
  });
  const deleted = cookies.length - toKeep.length;
  await browserContext.clearCookies();
  if (toKeep.length) await browserContext.addCookies(toKeep as any);
  return { content: [{ type: "text", text: `Deleted ${deleted} cookie(s).` }] };
});

// ── Tools: Dialog ──────────────────────────────────────────────────────────

server.tool("dialog_handle", "Set handler for next alert/confirm/prompt.", {
  action: z.enum(["accept", "dismiss"]).default("accept"),
  prompt_text: z.string().default(""),
}, async ({ action, prompt_text }) => {
  const page = getPage();
  page.once("dialog", async (dialog: Dialog) => {
    if (action === "accept") await dialog.accept(prompt_text);
    else await dialog.dismiss();
  });
  return { content: [{ type: "text", text: `Next dialog will be ${action}'d` }] };
});

// ── Tools: File Upload ─────────────────────────────────────────────────────

server.tool("upload_file", "Upload file to file input.", {
  ref: z.string(), file_path: z.string(),
}, async ({ ref, file_path }) => {
  const page = getPage();
  await page.locator(`[data-mcp-ref="${ref}"]`).first().setInputFiles(file_path, { timeout: 5000 });
  return { content: [{ type: "text", text: `Uploaded ${file_path} to ref=${ref}` }] };
});

// ── Tools: Scroll ──────────────────────────────────────────────────────────

server.tool("scroll", "Scroll the page.", {
  direction: z.enum(["up", "down", "left", "right"]).default("down"),
  amount: z.number().default(500),
}, async ({ direction, amount }) => {
  const page = getPage();
  let dx = 0, dy = 0;
  if (direction === "down") dy = amount;
  else if (direction === "up") dy = -amount;
  else if (direction === "right") dx = amount;
  else if (direction === "left") dx = -amount;
  // Use JS scroll — mouse.wheel doesn't work reliably in Firefox/Camoufox
  await page.evaluate(`window.scrollBy(${dx}, ${dy})`);
  await page.waitForTimeout(300);
  return { content: [{ type: "text", text: `Scrolled ${direction} ${amount}px` }] };
});

// ── Tools: Console & Network ───────────────────────────────────────────────

const consoleMessages: { type: string; text: string }[] = [];
const networkRequests: { method: string; status: number; url: string }[] = [];

server.tool("console_start", "Start capturing console messages.", {}, async () => {
  const page = getPage();
  consoleMessages.length = 0;
  page.on("console", (msg) => {
    consoleMessages.push({ type: msg.type(), text: msg.text().slice(0, 200) });
  });
  return { content: [{ type: "text", text: "Console capture started." }] };
});

server.tool("console_get", "Get captured console messages.", {}, async () => {
  if (!consoleMessages.length) return { content: [{ type: "text", text: "No messages." }] };
  const lines = consoleMessages.slice(-50).map(m => `  [${m.type}] ${m.text}`);
  return { content: [{ type: "text", text: `Console (${consoleMessages.length}):\n${lines.join("\n")}` }] };
});

server.tool("network_start", "Start capturing network requests.", {}, async () => {
  const page = getPage();
  networkRequests.length = 0;
  page.on("response", (res) => {
    networkRequests.push({
      method: res.request().method(),
      status: res.status(),
      url: res.url().slice(0, 120),
    });
  });
  return { content: [{ type: "text", text: "Network capture started." }] };
});

server.tool("network_get", "Get captured network requests.", {}, async () => {
  if (!networkRequests.length) return { content: [{ type: "text", text: "No requests." }] };
  const lines = networkRequests.slice(-50).map(r => `  ${r.method} ${r.status} ${r.url}`);
  return { content: [{ type: "text", text: `Network (${networkRequests.length}):\n${lines.join("\n")}` }] };
});

// ── Tools: PDF ─────────────────────────────────────────────────────────────

server.tool("save_pdf", "Save page as PDF.", {
  path: z.string().default(""),
}, async ({ path: pdfPath }) => {
  const page = getPage();
  const target = pdfPath || join(SCREENSHOT_DIR, "page.pdf");
  await page.pdf({ path: target });
  return { content: [{ type: "text", text: `PDF saved: ${target}` }] };
});

// ── Tools: Batch Operations ────────────────────────────────────────────────

server.tool("batch_actions", "Execute multiple actions in one call. Each action: {type, ref?, value?, text?, key?, url?}.", {
  actions: z.array(z.object({
    type: z.enum(["click", "fill", "type", "press", "select", "check", "uncheck", "wait"]),
    ref: z.string().optional(),
    value: z.string().optional(),
    text: z.string().optional(),
    key: z.string().optional(),
    timeout: z.number().optional(),
  })).describe("List of actions to execute sequentially"),
}, async ({ actions }) => {
  const page = getPage();
  const results: string[] = [];
  for (const action of actions) {
    try {
      if (action.type === "click" && action.ref) {
        const loc = page.locator(`[data-mcp-ref="${action.ref}"]`).first();
        try { await loc.click({ timeout: 5000 }); } catch { await loc.evaluate((el: any) => el.click()); }
        results.push(`click ${action.ref}: OK`);
      } else if (action.type === "fill" && action.ref && action.value !== undefined) {
        await page.locator(`[data-mcp-ref="${action.ref}"]`).first().fill(action.value, { timeout: 5000 });
        results.push(`fill ${action.ref}: OK`);
      } else if (action.type === "type" && action.text) {
        await page.keyboard.type(action.text, { delay: 50 });
        results.push(`type: OK`);
      } else if (action.type === "press" && action.key) {
        await page.keyboard.press(action.key);
        results.push(`press ${action.key}: OK`);
      } else if (action.type === "select" && action.ref && action.value) {
        await page.locator(`[data-mcp-ref="${action.ref}"]`).first().selectOption(action.value, { timeout: 5000 });
        results.push(`select ${action.ref}: OK`);
      } else if (action.type === "check" && action.ref) {
        await page.locator(`[data-mcp-ref="${action.ref}"]`).first().check({ timeout: 5000 });
        results.push(`check ${action.ref}: OK`);
      } else if (action.type === "uncheck" && action.ref) {
        await page.locator(`[data-mcp-ref="${action.ref}"]`).first().uncheck({ timeout: 5000 });
        results.push(`uncheck ${action.ref}: OK`);
      } else if (action.type === "wait") {
        await page.waitForTimeout(action.timeout || 1000);
        results.push(`wait ${action.timeout || 1000}ms: OK`);
      }
      await page.waitForTimeout(300);
    } catch (e: any) {
      results.push(`${action.type} ${action.ref || ""}: FAIL — ${e.message?.slice(0, 60)}`);
    }
  }
  return { content: [{ type: "text", text: `Batch (${actions.length} actions):\n${results.map(r => "  " + r).join("\n")}` }] };
});

server.tool("fill_form", "Fill multiple form fields and optionally submit.", {
  fields: z.array(z.object({
    ref: z.string().describe("Element ref from snapshot"),
    value: z.string().describe("Value to fill"),
  })),
  submit_ref: z.string().optional().describe("Ref of submit button to click after filling"),
}, async ({ fields, submit_ref }) => {
  const page = getPage();
  for (const f of fields) {
    await page.locator(`[data-mcp-ref="${f.ref}"]`).first().fill(f.value, { timeout: 5000 });
  }
  if (submit_ref) {
    const btn = page.locator(`[data-mcp-ref="${submit_ref}"]`).first();
    try { await btn.click({ timeout: 5000 }); } catch { await btn.evaluate((el: any) => el.click()); }
  }
  await page.waitForTimeout(1000);
  return { content: [{ type: "text", text: `Filled ${fields.length} fields${submit_ref ? " + submitted" : ""}. URL: ${page.url()}` }] };
});

server.tool("navigate_and_snapshot", "Navigate to URL then return snapshot — combined in one call.", {
  url: z.string(),
  wait_until: z.enum(["domcontentloaded", "load", "networkidle"]).default("domcontentloaded"),
}, async ({ url, wait_until }) => {
  const page = getPage();
  await page.goto(url, { waitUntil: wait_until, timeout: 30000 });
  await page.waitForTimeout(1500);
  const elements = await page.evaluate(SNAPSHOT_JS) || [];
  const text = formatSnapshot(elements as any[], page.url(), await page.title());
  return { content: [{ type: "text", text }] };
});

// ── Tools: Element Inspection ──────────────────────────────────────────────

server.tool("inspect_element", "Get detailed info about an element (tag, attributes, bounding box, styles).", {
  ref: z.string(),
}, async ({ ref }) => {
  const page = getPage();
  const info = await page.locator(`[data-mcp-ref="${ref}"]`).first().evaluate((el: any) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const attrs: Record<string, string> = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    return {
      tag: el.tagName.toLowerCase(), id: el.id, className: el.className,
      text: (el.innerText || "").slice(0, 200), value: el.value || "",
      attrs, rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      visible: cs.display !== "none" && cs.visibility !== "hidden",
      fontSize: cs.fontSize, color: cs.color, bg: cs.backgroundColor,
    };
  });
  return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
});

server.tool("get_attribute", "Get a specific attribute value from an element.", {
  ref: z.string(), attribute: z.string(),
}, async ({ ref, attribute }) => {
  const page = getPage();
  const val = await page.locator(`[data-mcp-ref="${ref}"]`).first().getAttribute(attribute);
  return { content: [{ type: "text", text: `${attribute}=${val}` }] };
});

server.tool("query_selector_all", "Query elements by CSS selector, return text/attributes of all matches.", {
  selector: z.string(),
  attribute: z.string().default("").describe("Attribute to extract (empty = innerText)"),
  limit: z.number().default(20),
}, async ({ selector, attribute, limit }) => {
  const page = getPage();
  const results = await page.evaluate(`(() => {
    var els = document.querySelectorAll("${selector.replace(/"/g, '\\"')}");
    var out = [];
    for (var i = 0; i < Math.min(els.length, ${limit}); i++) {
      out.push({
        i: i,
        text: (els[i].innerText || '').trim().slice(0, 100),
        attr: "${attribute}" ? els[i].getAttribute("${attribute}") || '' : '',
        tag: els[i].tagName.toLowerCase()
      });
    }
    return { total: els.length, items: out };
  })()`);
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
});

server.tool("get_links", "Get all links on the page with URL and text.", {
  filter: z.string().default("").describe("Filter links by URL pattern (empty = all)"),
}, async ({ filter }) => {
  const page = getPage();
  const links = await page.evaluate(`(() => {
    var links = document.querySelectorAll('a[href]');
    var out = [];
    for (var i = 0; i < links.length; i++) {
      var href = links[i].href || '';
      var text = (links[i].innerText || '').trim().slice(0, 80);
      if (!text && !href) continue;
      if ("${filter}" && href.indexOf("${filter}") === -1) continue;
      out.push({ text: text, href: href.slice(0, 150) });
    }
    return out;
  })()`);
  const arr = links as any[];
  const lines = arr.slice(0, 50).map((l: any) => `  ${l.text || "(no text)"} → ${l.href}`);
  return { content: [{ type: "text", text: `Links (${arr.length}):\n${lines.join("\n")}` }] };
});

// ── Tools: Storage ─────────────────────────────────────────────────────────

server.tool("localstorage_get", "Get all localStorage data or a specific key.", {
  key: z.string().default("").describe("Key to get (empty = all)"),
}, async ({ key }) => {
  const page = getPage();
  if (key) {
    const val = await page.evaluate(`localStorage.getItem("${key.replace(/"/g, '\\"')}")`);
    return { content: [{ type: "text", text: `${key}=${val}` }] };
  }
  const all = await page.evaluate(`(() => { var o = {}; for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; })()`);
  return { content: [{ type: "text", text: JSON.stringify(all, null, 2) }] };
});

server.tool("localstorage_set", "Set a localStorage item.", {
  key: z.string(), value: z.string(),
}, async ({ key, value }) => {
  const page = getPage();
  await page.evaluate(`localStorage.setItem("${key.replace(/"/g, '\\"')}", "${value.replace(/"/g, '\\"')}")`);
  return { content: [{ type: "text", text: `localStorage set: ${key}` }] };
});

server.tool("localstorage_clear", "Clear all localStorage.", {}, async () => {
  const page = getPage();
  await page.evaluate(`localStorage.clear()`);
  return { content: [{ type: "text", text: "localStorage cleared." }] };
});

server.tool("sessionstorage_get", "Get all sessionStorage data or a specific key.", {
  key: z.string().default(""),
}, async ({ key }) => {
  const page = getPage();
  if (key) {
    const val = await page.evaluate(`sessionStorage.getItem("${key.replace(/"/g, '\\"')}")`);
    return { content: [{ type: "text", text: `${key}=${val}` }] };
  }
  const all = await page.evaluate(`(() => { var o = {}; for (var i = 0; i < sessionStorage.length; i++) { var k = sessionStorage.key(i); o[k] = sessionStorage.getItem(k); } return o; })()`);
  return { content: [{ type: "text", text: JSON.stringify(all, null, 2) }] };
});

server.tool("sessionstorage_set", "Set a sessionStorage item.", {
  key: z.string(), value: z.string(),
}, async ({ key, value }) => {
  const page = getPage();
  await page.evaluate(`sessionStorage.setItem("${key.replace(/"/g, '\\"')}", "${value.replace(/"/g, '\\"')}")`);
  return { content: [{ type: "text", text: `sessionStorage set: ${key}` }] };
});

// ── Tools: Mouse XY ────────────────────────────────────────────────────────

server.tool("mouse_click_xy", "Click at exact x,y coordinates on the page.", {
  x: z.number(), y: z.number(),
  button: z.enum(["left", "right", "middle"]).default("left"),
}, async ({ x, y, button }) => {
  const page = getPage();
  await page.mouse.click(x, y, { button });
  await page.waitForTimeout(500);
  return { content: [{ type: "text", text: `Clicked at (${x}, ${y}) button=${button}` }] };
});

server.tool("mouse_move", "Move mouse to exact x,y coordinates.", {
  x: z.number(), y: z.number(),
}, async ({ x, y }) => {
  const page = getPage();
  await page.mouse.move(x, y);
  return { content: [{ type: "text", text: `Mouse moved to (${x}, ${y})` }] };
});

server.tool("drag_and_drop", "Drag from one element to another.", {
  source_ref: z.string().describe("Ref of element to drag"),
  target_ref: z.string().describe("Ref of drop target"),
}, async ({ source_ref, target_ref }) => {
  const page = getPage();
  const src = page.locator(`[data-mcp-ref="${source_ref}"]`).first();
  const tgt = page.locator(`[data-mcp-ref="${target_ref}"]`).first();
  await src.dragTo(tgt, { timeout: 5000 });
  return { content: [{ type: "text", text: `Dragged ${source_ref} → ${target_ref}` }] };
});

// ── Tools: Frames/Iframes ──────────────────────────────────────────────────

server.tool("list_frames", "List all frames/iframes in the page.", {}, async () => {
  const page = getPage();
  const frames = page.frames();
  const lines = frames.map((f, i) => `  [${i}] ${f.name() || "(unnamed)"} — ${f.url().slice(0, 100)}`);
  return { content: [{ type: "text", text: `Frames (${frames.length}):\n${lines.join("\n")}` }] };
});

server.tool("frame_evaluate", "Execute JavaScript inside a specific frame/iframe.", {
  frame_name: z.string().default("").describe("Frame name (empty = by index)"),
  frame_index: z.number().default(0).describe("Frame index from list_frames"),
  expression: z.string(),
}, async ({ frame_name, frame_index, expression }) => {
  const page = getPage();
  const frame = frame_name
    ? page.frames().find(f => f.name() === frame_name)
    : page.frames()[frame_index];
  if (!frame) return { content: [{ type: "text", text: "Frame not found." }] };
  const result = await frame.evaluate(expression);
  return { content: [{ type: "text", text: typeof result === "object" ? JSON.stringify(result, null, 2) : String(result) }] };
});

// ── Tools: Wait (extended) ─────────────────────────────────────────────────

server.tool("wait_for_url", "Wait for URL to match a pattern.", {
  pattern: z.string().describe("URL substring or regex pattern"),
  timeout: z.number().default(15000),
}, async ({ pattern, timeout }) => {
  const page = getPage();
  await page.waitForURL(pattern.startsWith("/") ? new RegExp(pattern.slice(1, -1)) : `**/*${pattern}*`, { timeout });
  return { content: [{ type: "text", text: `URL matched pattern '${pattern}'. Current: ${page.url()}` }] };
});

server.tool("wait_for_response", "Wait for a network response matching a URL pattern.", {
  url_pattern: z.string().describe("URL substring to match"),
  timeout: z.number().default(15000),
}, async ({ url_pattern, timeout }) => {
  const page = getPage();
  const resp = await page.waitForResponse(r => r.url().includes(url_pattern), { timeout });
  return { content: [{ type: "text", text: `Response: ${resp.status()} ${resp.url().slice(0, 120)}` }] };
});

// ── Tools: Viewport ────────────────────────────────────────────────────────

server.tool("get_viewport_size", "Get current viewport dimensions.", {}, async () => {
  const page = getPage();
  const size = page.viewportSize();
  return { content: [{ type: "text", text: `Viewport: ${size?.width || "?"}x${size?.height || "?"}` }] };
});

server.tool("set_viewport_size", "Set viewport width and height.", {
  width: z.number(), height: z.number(),
}, async ({ width, height }) => {
  const page = getPage();
  await page.setViewportSize({ width, height });
  return { content: [{ type: "text", text: `Viewport set to ${width}x${height}` }] };
});

// ── Tools: Accessibility ───────────────────────────────────────────────────

server.tool("accessibility_snapshot", "Get accessibility tree snapshot — compact view of page structure for LLM understanding.", {}, async () => {
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

server.tool("server_status", "Health check — verify server, browser status, active tabs.", {}, async () => {
  return { content: [{ type: "text", text: JSON.stringify({
    browser_up: browserUp,
    active_tabs: pages.length,
    active_page: activePage,
    current_url: browserUp && pages.length > 0 ? pages[activePage]?.url() : null,
    profile_dir: PROFILE_DIR,
    screenshot_dir: SCREENSHOT_DIR,
  }, null, 2) }] };
});

server.tool("get_page_errors", "Get JavaScript errors from the page.", {}, async () => {
  const page = getPage();
  const errors = await page.evaluate(`(() => {
    var errs = window.__mcp_errors || [];
    return errs.slice(-20);
  })()`);
  return { content: [{ type: "text", text: JSON.stringify(errors, null, 2) }] };
});

server.tool("inject_init_script", "Inject a script that runs before every page load.", {
  script: z.string().describe("JavaScript code to inject"),
}, async ({ script }) => {
  if (!browserContext) throw new Error("Browser not running.");
  await browserContext.addInitScript(script);
  return { content: [{ type: "text", text: "Init script injected. Will run on every new page/navigation." }] };
});

// ── Tools: Export ──────────────────────────────────────────────────────────

server.tool("export_har", "Export network traffic as HAR file.", {
  path: z.string().default(""),
}, async ({ path: harPath }) => {
  const page = getPage();
  const target = harPath || join(SCREENSHOT_DIR, "network.har");
  // Collect network entries
  const entries = networkRequests.slice(-100).map(r => ({
    request: { method: r.method, url: r.url },
    response: { status: r.status },
  }));
  const har = { log: { version: "1.2", entries } };
  writeFileSync(target, JSON.stringify(har, null, 2));
  return { content: [{ type: "text", text: `HAR exported: ${target} (${entries.length} entries)` }] };
});

// ── Tools: Scraping / Extraction ───────────────────────────────────────────

server.tool("detect_content_pattern", "Auto-detect repeated content patterns (cards, listings, rows) and suggest CSS selectors. Run this BEFORE extract_structured to find the right selectors.", {
  min_items: z.number().default(3).describe("Minimum repeated items to detect as pattern"),
}, async ({ min_items }) => {
  const page = getPage();
  const patterns = await page.evaluate(`(() => {
    // Count children with same tag+class per parent
    var candidates = [];
    var parents = document.querySelectorAll('main, [role="main"], section, div, ul, ol, tbody');
    for (var p = 0; p < parents.length; p++) {
      var parent = parents[p];
      var childMap = {};
      for (var c = 0; c < parent.children.length; c++) {
        var child = parent.children[c];
        var key = child.tagName;
        if (child.className) key += '.' + child.className.split(' ').filter(function(c){return c.length>0}).slice(0,2).join('.');
        if (!childMap[key]) childMap[key] = { count: 0, tag: child.tagName.toLowerCase(), cls: child.className, sample: '' };
        childMap[key].count++;
        if (!childMap[key].sample) childMap[key].sample = (child.innerText || '').trim().slice(0, 150);
      }
      var keys = Object.keys(childMap);
      for (var k = 0; k < keys.length; k++) {
        if (childMap[keys[k]].count >= ${min_items}) {
          var info = childMap[keys[k]];
          // Build selector
          var sel = info.tag;
          if (info.cls) {
            var classes = info.cls.split(' ').filter(function(c){return c.length > 0 && c.length < 40}).slice(0,2);
            if (classes.length > 0) sel = info.tag + '.' + classes.join('.');
          }
          // Find child elements for field suggestions
          var firstItem = parent.querySelector(sel);
          var fieldHints = [];
          if (firstItem) {
            var links = firstItem.querySelectorAll('a[href]');
            if (links.length > 0) fieldHints.push({ name: 'url', selector: 'a', attribute: 'href', sample: links[0].href.slice(0, 100) });
            var headings = firstItem.querySelectorAll('h1,h2,h3,h4,h5,h6');
            if (headings.length > 0) fieldHints.push({ name: 'title', selector: headings[0].tagName.toLowerCase(), attribute: '', sample: headings[0].innerText.trim().slice(0, 60) });
            var imgs = firstItem.querySelectorAll('img[src]');
            if (imgs.length > 0) fieldHints.push({ name: 'image', selector: 'img', attribute: 'src', sample: imgs[0].src.slice(0, 80) });
            // Find text-heavy spans/divs
            var texts = firstItem.querySelectorAll('span, p, div');
            var textItems = [];
            for (var t = 0; t < texts.length; t++) {
              var txt = texts[t].innerText.trim();
              if (txt.length > 5 && txt.length < 100 && texts[t].children.length === 0) {
                var tSel = texts[t].tagName.toLowerCase();
                if (texts[t].className) tSel += '.' + texts[t].className.split(' ').filter(function(c){return c.length>0&&c.length<40}).slice(0,1).join('.');
                textItems.push({ selector: tSel, sample: txt.slice(0, 60) });
              }
            }
            for (var ti = 0; ti < Math.min(textItems.length, 3); ti++) {
              fieldHints.push({ name: 'field_' + ti, selector: textItems[ti].selector, attribute: '', sample: textItems[ti].sample });
            }
          }
          candidates.push({
            selector: sel,
            count: info.count,
            sample_text: info.sample.slice(0, 100),
            suggested_fields: fieldHints
          });
        }
      }
    }
    // Sort by count desc, deduplicate by selector
    candidates.sort(function(a,b){ return b.count - a.count; });
    var seen = {};
    var unique = [];
    for (var u = 0; u < candidates.length; u++) {
      if (!seen[candidates[u].selector]) {
        seen[candidates[u].selector] = true;
        unique.push(candidates[u]);
      }
    }
    return unique.slice(0, 10);
  })()`);
  const arr = patterns as any[];
  if (arr.length === 0) {
    return { content: [{ type: "text", text: "No repeated content patterns detected. Try scrolling down to load more content." }] };
  }
  let text = `Detected ${arr.length} content pattern(s):\n\n`;
  for (const p of arr) {
    text += `--- ${p.count} items: ${p.selector} ---\n`;
    text += `Sample: "${p.sample_text}"\n`;
    if (p.suggested_fields?.length) {
      text += `Suggested extract_structured call:\n`;
      text += `  container_selector: "${p.selector}"\n`;
      text += `  fields:\n`;
      for (const f of p.suggested_fields) {
        text += `    - {name: "${f.name}", selector: "${f.selector}"${f.attribute ? `, attribute: "${f.attribute}"` : ''}} → "${f.sample}"\n`;
      }
    }
    text += `\n`;
  }
  return { content: [{ type: "text", text }] };
});

server.tool("extract_structured", "Extract structured data from repeated elements (cards, rows, listings). Auto-deduplicates, filters empty items, extracts direct text only. Use detect_content_pattern first to find correct selectors.", {
  container_selector: z.string().describe("CSS selector for each repeated item. Use detect_content_pattern to find this."),
  fields: z.array(z.object({
    name: z.string().describe("Field name in output"),
    selector: z.string().describe("CSS selector within each item"),
    attribute: z.string().default("").describe("Attribute to extract (empty = direct text only)"),
  })).describe("Fields to extract from each item"),
  limit: z.number().default(50).describe("Max items to extract"),
  deduplicate_by: z.string().default("").describe("Field name to deduplicate by (empty = auto)"),
  direct_text_only: z.boolean().default(true).describe("Extract only direct text of matched element, not children text (prevents field mixing)"),
}, async ({ container_selector, fields, limit, deduplicate_by, direct_text_only }) => {
  const page = getPage();
  const fieldsDef = JSON.stringify(fields);
  const results = await page.evaluate(`(() => {
    // Helper: get direct text only (no children text) to prevent field mixing
    function directText(el) {
      var text = '';
      for (var n = 0; n < el.childNodes.length; n++) {
        if (el.childNodes[n].nodeType === 3) text += el.childNodes[n].textContent;
      }
      text = text.trim();
      // If direct text empty, fall back to first line of innerText
      if (!text) {
        var lines = (el.innerText || '').trim().split('\\n');
        text = lines[0] || '';
      }
      return text.trim();
    }

    // Get ALL matching containers, then filter to only top-level (not nested)
    var allContainers = document.querySelectorAll("${container_selector.replace(/"/g, '\\"')}");
    var containers = [];
    for (var c = 0; c < allContainers.length; c++) {
      var isNested = false;
      var parent = allContainers[c].parentElement;
      while (parent) {
        if (parent.matches && parent.matches("${container_selector.replace(/"/g, '\\"')}")) {
          isNested = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (!isNested) containers.push(allContainers[c]);
    }

    var fields = ${fieldsDef};
    var directOnly = ${direct_text_only};
    var out = [];
    var seenKeys = {};
    var dedup = "${deduplicate_by}";

    for (var i = 0; i < Math.min(containers.length, ${limit * 2}); i++) {
      var item = {};
      var nonEmptyCount = 0;

      for (var j = 0; j < fields.length; j++) {
        var f = fields[j];
        var el = containers[i].querySelector(f.selector);
        if (el) {
          var val;
          if (f.attribute) {
            val = el.getAttribute(f.attribute) || '';
          } else if (directOnly) {
            val = directText(el);
          } else {
            val = (el.innerText || '').trim();
          }
          item[f.name] = val;
          if (val) nonEmptyCount++;
        } else {
          item[f.name] = '';
        }
      }

      // P0: Skip items where all fields are empty
      if (nonEmptyCount === 0) continue;

      // P0: Deduplicate
      var dedupKey = '';
      if (dedup && item[dedup]) {
        dedupKey = item[dedup];
      } else {
        for (var d = 0; d < fields.length; d++) {
          if (item[fields[d].name]) { dedupKey = item[fields[d].name]; break; }
        }
      }
      if (dedupKey && seenKeys[dedupKey]) continue;
      if (dedupKey) seenKeys[dedupKey] = true;

      out.push(item);
      if (out.length >= ${limit}) break;
    }

    return {
      total_on_page: allContainers.length,
      top_level: containers.length,
      unique_extracted: out.length,
      items: out
    };
  })()`);
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
});

server.tool("extract_table", "Extract data from an HTML table as JSON array.", {
  selector: z.string().default("table").describe("CSS selector for the table"),
  limit: z.number().default(100).describe("Max rows"),
}, async ({ selector, limit }) => {
  const page = getPage();
  const results = await page.evaluate(`(() => {
    var table = document.querySelector("${selector.replace(/"/g, '\\"')}");
    if (!table) return { error: 'Table not found' };
    var headers = [];
    var ths = table.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td');
    for (var i = 0; i < ths.length; i++) headers.push(ths[i].innerText.trim());
    var rows = table.querySelectorAll('tbody tr, tr');
    var out = [];
    var start = headers.length > 0 ? 1 : 0;
    for (var r = start; r < Math.min(rows.length, ${limit} + start); r++) {
      var cells = rows[r].querySelectorAll('td, th');
      var row = {};
      for (var c = 0; c < cells.length; c++) {
        var key = headers[c] || ('col_' + c);
        var link = cells[c].querySelector('a');
        row[key] = cells[c].innerText.trim();
        if (link) row[key + '_url'] = link.href;
      }
      out.push(row);
    }
    return { headers: headers, total_rows: rows.length - start, extracted: out.length, rows: out };
  })()`);
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
});

server.tool("scrape_page", "Smart page scraper — auto-detect and extract main content, links, metadata. Strips nav/footer noise.", {
  include_links: z.boolean().default(true),
  include_meta: z.boolean().default(true),
  max_text_length: z.number().default(8000).describe("Max text chars (truncates at paragraph boundary)"),
  only_main_content: z.boolean().default(true).describe("Strip nav, header, footer, sidebar — extract only main content area"),
}, async ({ include_links, include_meta, max_text_length, only_main_content }) => {
  const page = getPage();
  const data = await page.evaluate(`(() => {
    var result = {};
    result.title = document.title;
    result.url = location.href;

    // Meta
    if (${include_meta}) {
      var metas = {};
      var metaEls = document.querySelectorAll('meta[name], meta[property]');
      for (var i = 0; i < metaEls.length; i++) {
        var key = metaEls[i].getAttribute('name') || metaEls[i].getAttribute('property');
        metas[key] = metaEls[i].getAttribute('content') || '';
      }
      result.meta = metas;
    }

    // Find main content area
    var textSource;
    if (${only_main_content}) {
      textSource = document.querySelector('main, [role="main"], #main-content, .main-content, #content, .content');
      // Exclude nav/footer/sidebar from the source
      if (textSource) {
        var clone = textSource.cloneNode(true);
        var noise = clone.querySelectorAll('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .sidebar, .nav, .footer, .header');
        for (var n = 0; n < noise.length; n++) noise[n].remove();
        var fullText = clone.innerText.trim();
      } else {
        textSource = document.body;
        var fullText = textSource.innerText.trim();
      }
    } else {
      textSource = document.body;
      var fullText = textSource.innerText.trim();
    }

    // Smart truncation: cut at paragraph/newline boundary, not mid-word
    var totalLen = fullText.length;
    if (fullText.length > ${max_text_length}) {
      var cutText = fullText.slice(0, ${max_text_length});
      var lastNewline = cutText.lastIndexOf('\\n');
      if (lastNewline > ${max_text_length} * 0.8) {
        cutText = cutText.slice(0, lastNewline);
      }
      result.text = cutText;
      result.truncated = true;
      result.total_text_length = totalLen;
    } else {
      result.text = fullText;
      result.truncated = false;
      result.total_text_length = totalLen;
    }

    // Links from main content area
    if (${include_links}) {
      var linkSource = textSource || document.body;
      var links = linkSource.querySelectorAll('a[href]');
      var linkList = [];
      for (var j = 0; j < Math.min(links.length, 50); j++) {
        var text = (links[j].innerText || '').trim().slice(0, 80);
        if (text) linkList.push({ text: text, href: links[j].href });
      }
      result.links = linkList;
    }

    // Headings
    var headingSource = textSource || document.body;
    var headings = [];
    var hs = headingSource.querySelectorAll('h1, h2, h3');
    for (var k = 0; k < Math.min(hs.length, 20); k++) {
      headings.push({ level: hs[k].tagName, text: hs[k].innerText.trim().slice(0, 100) });
    }
    result.headings = headings;

    return result;
  })()`);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// ── Start Server ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-camoufox] Server running on stdio...");
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch((err) => {
  console.error("[mcp-camoufox] Fatal:", err);
  process.exit(1);
});
