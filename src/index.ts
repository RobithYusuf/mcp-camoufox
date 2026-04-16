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
      href: el.tagName === 'A' ? (el.href || '').slice(0, 120) : '',
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
