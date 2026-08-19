// Element interaction, keyboard, waits, JavaScript and page info.
//
// Registered by importing this module — see src/index.ts.
import { z } from "zod";
import type { BrowserContext, Page, Dialog } from "playwright-core";
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "fs";
import { getPage } from "../state.js";
import { ACTION_TIMEOUT, clickWithFallback, clickNote, fillLocator, refLocator,
         scopeRoot, describeMatches, candidateList } from "../helpers.js";
import { regTool } from "../server.js";

// ── Tools: Element Interaction ─────────────────────────────────────────────

regTool(
  "click",
  "Click element by ref ID from browser_snapshot. Auto JS-fallback for overlays.",
  {
    ref: z.string().describe("Element ref (e.g. 'e5')"),
    button: z.enum(["left", "right", "middle"]).default("left"),
    dblclick: z.boolean().default(false),
  },
  async ({ ref, button, dblclick }) => {
    const page = getPage();
    const mode = await clickWithFallback(refLocator(page, ref), { button, dblclick });
    await page.waitForTimeout(1000);
    return { content: [{ type: "text", text: `Clicked ref=${ref}. URL: ${page.url()}${clickNote(mode)}` }] };
  }
);

regTool(
  "click_text",
  "Click element by visible text. If the text matches several elements it FAILS with a numbered candidate list instead of silently clicking the first one — " +
    'narrow with within ("@dialog", a CSS selector, or "ref:e5") or pick one with index.',
  {
    text: z.string().describe("Visible text"),
    exact: z.boolean().default(true),
    within: z.string().default("").describe('Limit the search: "@dialog" = topmost modal, "ref:e5" = inside a snapshot ref, or any CSS selector.'),
    index: z.number().default(-1).describe("Which match to click when several match (0-based). -1 = require a unique match."),
  },
  async ({ text, exact, within, index }) => {
    const page = getPage();
    const scope = within ? ` within=${within}` : "";
    let loc: any;
    try {
      loc = scopeRoot(page, within).getByText(text, { exact });
    } catch (e: any) {
      return { content: [{ type: "text", text: `Invalid within=${within}: ${e?.message || e}` }], isError: true };
    }
    const n = await loc.count();
    if (n === 0) {
      return { content: [{ type: "text", text: `No element matched text='${text}' (exact=${exact})${scope}. Current URL: ${page.url()}. Try exact=false, a different within, browser_snapshot, or click_role.` }], isError: true };
    }
    if (n > 1 && index < 0) {
      const { total, items } = await describeMatches(loc);
      return {
        content: [{ type: "text", text: `Ambiguous: text='${text}'${scope} matches ${total} elements — refusing to guess (clicking the wrong one can be destructive).\n${candidateList(total, items)}\n\nRe-run with index=N, add within="@dialog"/CSS, or click(ref=…) using a ref above.` }],
        isError: true,
      };
    }
    if (index >= n) {
      return { content: [{ type: "text", text: `index=${index} out of range — only ${n} match(es) for text='${text}'${scope}.` }], isError: true };
    }
    const target = index >= 0 ? loc.nth(index) : loc.first();
    const mode = await clickWithFallback(target);
    await page.waitForTimeout(1000);
    return { content: [{ type: "text", text: `Clicked text='${text}'${scope}${n > 1 ? ` [index=${index} of ${n}]` : ""}. URL: ${page.url()}${clickNote(mode)}` }] };
  }
);

regTool(
  "click_role",
  "Click element by ARIA role and name. Same ambiguity guard as click_text: several matches → candidate list, not a guess.",
  {
    role: z.string().describe("ARIA role (button, link, textbox, etc.)"),
    name: z.string().default("").describe("Accessible name"),
    within: z.string().default("").describe('Limit the search: "@dialog", "ref:e5", or a CSS selector.'),
    index: z.number().default(-1).describe("Which match to click when several match (0-based). -1 = require a unique match."),
  },
  async ({ role, name: ariaName, within, index }) => {
    const page = getPage();
    const scope = within ? ` within=${within}` : "";
    let loc: any;
    try {
      const root = scopeRoot(page, within);
      loc = ariaName ? root.getByRole(role as any, { name: ariaName, exact: true }) : root.getByRole(role as any);
    } catch (e: any) {
      return { content: [{ type: "text", text: `Invalid within=${within}: ${e?.message || e}` }], isError: true };
    }
    const n = await loc.count();
    if (n === 0) {
      return { content: [{ type: "text", text: `No element matched role=${role} name='${ariaName}'${scope}. Current URL: ${page.url()}. Try browser_snapshot or click_text.` }], isError: true };
    }
    if (n > 1 && index < 0) {
      const { total, items } = await describeMatches(loc);
      return {
        content: [{ type: "text", text: `Ambiguous: role=${role} name='${ariaName}'${scope} matches ${total} elements — refusing to guess.\n${candidateList(total, items)}\n\nRe-run with index=N, add within=…, or click(ref=…).` }],
        isError: true,
      };
    }
    if (index >= n) {
      return { content: [{ type: "text", text: `index=${index} out of range — only ${n} match(es) for role=${role} name='${ariaName}'${scope}.` }], isError: true };
    }
    const target = index >= 0 ? loc.nth(index) : loc.first();
    const mode = await clickWithFallback(target);
    await page.waitForTimeout(1000);
    return { content: [{ type: "text", text: `Clicked role=${role} name='${ariaName}'${scope}${n > 1 ? ` [index=${index} of ${n}]` : ""}. URL: ${page.url()}${clickNote(mode)}` }] };
  }
);

regTool("hover", "Hover over element by ref ID.", {
  ref: z.string(),
}, async ({ ref }) => {
  const page = getPage();
  await refLocator(page, ref).hover({ timeout: ACTION_TIMEOUT });
  return { content: [{ type: "text", text: `Hovered ref=${ref}` }] };
});

regTool("fill", "Fill input/textarea by ref ID. Always replaces existing content (email/number inputs are cleared explicitly first — Firefox's select-all is a no-op on those, which would otherwise append).", {
  ref: z.string().describe("Element ref"),
  value: z.string().describe("Text to fill"),
}, async ({ ref, value }) => {
  const page = getPage();
  const loc = refLocator(page, ref);
  await fillLocator(loc, value);
  // Never echo a password back into the agent transcript / logs.
  const secret = await loc.evaluate((el: any) => {
    const t = String(el.type || "").toLowerCase();
    const hint = `${el.name || ""} ${el.id || ""} ${el.getAttribute("autocomplete") || ""}`.toLowerCase();
    return t === "password" || /pass|secret|token|otp|cvv|card|pin/.test(hint);
  }).catch(() => false);
  return { content: [{ type: "text", text: secret
    ? `Filled ref=${ref} (${value.length} chars, value masked — looks like a secret field)`
    : `Filled ref=${ref} with '${value.slice(0, 50)}'` }] };
});

regTool("select_option", "Select option from <select> dropdown.", {
  ref: z.string(), value: z.string(),
}, async ({ ref, value }) => {
  const page = getPage();
  await refLocator(page, ref).selectOption(value, { timeout: ACTION_TIMEOUT });
  return { content: [{ type: "text", text: `Selected '${value}' in ref=${ref}` }] };
});

regTool("check", "Check checkbox or radio button.", { ref: z.string() }, async ({ ref }) => {
  const page = getPage();
  await refLocator(page, ref).check({ timeout: ACTION_TIMEOUT });
  return { content: [{ type: "text", text: `Checked ref=${ref}` }] };
});

regTool("uncheck", "Uncheck a checkbox.", { ref: z.string() }, async ({ ref }) => {
  const page = getPage();
  await refLocator(page, ref).uncheck({ timeout: ACTION_TIMEOUT });
  return { content: [{ type: "text", text: `Unchecked ref=${ref}` }] };
});

// ── Tools: Keyboard ────────────────────────────────────────────────────────

regTool("type_text", "Type text char by char via keyboard.", {
  text: z.string(),
  delay: z.number().default(50).describe("Delay between keys (ms)"),
}, async ({ text, delay }) => {
  const page = getPage();
  await page.keyboard.type(text, { delay });
  return { content: [{ type: "text", text: `Typed: '${text.slice(0, 50)}'` }] };
});

regTool("press_key", "Press key or combo (Enter, Escape, Control+a, etc.).", {
  key: z.string().describe("Key name"),
}, async ({ key }) => {
  const page = getPage();
  await page.keyboard.press(key);
  await page.waitForTimeout(300);
  return { content: [{ type: "text", text: `Pressed: ${key}` }] };
});

// ── Tools: Wait ────────────────────────────────────────────────────────────

regTool("wait_for", "Wait for element/text to appear or disappear.", {
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

regTool("wait_for_navigation", "Wait for page load to complete.", {
  timeout: z.number().default(15000),
}, async ({ timeout }) => {
  const page = getPage();
  await page.waitForLoadState("domcontentloaded", { timeout });
  return { content: [{ type: "text", text: `Navigation complete. URL: ${page.url()}` }] };
});

regTool(
  "wait_for_any_of",
  "Race multiple wait conditions — returns the first that matches, so the agent can branch immediately without sequential probes. " +
    "Each condition is {kind: 'selector'|'text'|'url_contains'|'title_contains', value: string}. " +
    "Returns the index + kind + value of the winning condition (or 'timeout' if none matched). " +
    "Ideal for post-login flows where the next page could be any of several (e.g. 'Stay signed in?', 'Skip for now', or the inbox directly).",
  {
    conditions: z.array(z.object({
      kind: z.enum(["selector", "text", "url_contains", "title_contains"]),
      value: z.string(),
    })).describe("Conditions to race. First match wins."),
    timeout: z.number().default(15000).describe("Max wait in ms"),
  },
  async ({ conditions, timeout }) => {
    if (!conditions || conditions.length === 0) {
      return {
        content: [{ type: "text", text: "Error: conditions array is empty" }],
        isError: true,
      };
    }
    const page = getPage();
    const deadline = Date.now() + timeout;

    // Poll-based race — works for url/title (no native waitFor for those across all kinds)
    // and for selector/text uses Playwright's waitFor with short slices so we can return early
    // when a different condition wins.
    const pollMs = 250;
    while (Date.now() < deadline) {
      // Check all conditions in parallel via a single page.evaluate where possible
      const url = page.url();
      const title = await page.title().catch(() => "");
      for (let i = 0; i < conditions.length; i++) {
        const c = conditions[i];
        try {
          if (c.kind === "url_contains" && url.includes(c.value)) {
            return { content: [{ type: "text", text: `matched index=${i} kind=url_contains value="${c.value}" url=${url}` }] };
          }
          if (c.kind === "title_contains" && title.toLowerCase().includes(c.value.toLowerCase())) {
            return { content: [{ type: "text", text: `matched index=${i} kind=title_contains value="${c.value}" title="${title}"` }] };
          }
          if (c.kind === "selector") {
            const visible = await page.locator(c.value).first().isVisible().catch(() => false);
            if (visible) {
              return { content: [{ type: "text", text: `matched index=${i} kind=selector value="${c.value}"` }] };
            }
          }
          if (c.kind === "text") {
            const visible = await page.getByText(c.value).first().isVisible().catch(() => false);
            if (visible) {
              return { content: [{ type: "text", text: `matched index=${i} kind=text value="${c.value}"` }] };
            }
          }
        } catch {}
      }
      await page.waitForTimeout(pollMs);
    }
    return {
      content: [{ type: "text", text: `timeout: no condition matched within ${timeout}ms. Current URL: ${page.url()}` }],
    };
  }
);

// ── Tools: JavaScript ──────────────────────────────────────────────────────

regTool("evaluate", "Execute JavaScript in page context.", {
  expression: z.string().describe("JS expression"),
}, async ({ expression }) => {
  const page = getPage();
  const result = await page.evaluate(expression);
  const text = typeof result === "object" ? JSON.stringify(result, null, 2) : String(result);
  return { content: [{ type: "text", text }] };
});

// ── Tools: Page Info ───────────────────────────────────────────────────────

regTool("get_url", "Get current URL and title.", {}, async () => {
  const page = getPage();
  return { content: [{ type: "text", text: `URL: ${page.url()}\nTitle: ${await page.title()}` }] };
});

regTool("get_text", "Get visible text from page or element.", {
  selector: z.string().default("body"),
}, async ({ selector }) => {
  const page = getPage();
  let text = await page.locator(selector).first().innerText({ timeout: ACTION_TIMEOUT });
  if (text.length > 5000) text = text.slice(0, 5000) + `\n... (truncated, ${text.length} chars)`;
  return { content: [{ type: "text", text }] };
});

regTool("get_html", "Get HTML content from page or element.", {
  selector: z.string().default("body"),
  outer: z.boolean().default(false),
}, async ({ selector, outer }) => {
  const page = getPage();
  const loc = page.locator(selector).first();
  let html = outer
    ? await loc.evaluate((el: any) => el.outerHTML)
    : await loc.innerHTML({ timeout: ACTION_TIMEOUT });
  if (html.length > 10000) html = html.slice(0, 10000) + `\n<!-- truncated -->`;
  return { content: [{ type: "text", text: html }] };
});
