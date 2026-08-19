// Scraping and extraction, compound calls, smart selectors, cookie portability and page stats.
//
// Registered by importing this module — see src/index.ts.
import { z } from "zod";
import type { BrowserContext, Page, Dialog } from "playwright-core";
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "fs";
import { S, getPage } from "../state.js";
import { jsStr, clickWithFallback, clickNote, refLocator,
         scopeRoot, describeMatches, candidateList, snapshotPage, waitReady } from "../helpers.js";
import { regTool } from "../server.js";

// ── Tools: Scraping / Extraction ───────────────────────────────────────────

regTool("detect_content_pattern", "Auto-detect repeated content patterns (cards, listings, rows) and suggest CSS selectors. Run this BEFORE extract_structured to find the right selectors.", {
  min_items: z.number().default(3).describe("Minimum repeated items to detect as pattern"),
}, async ({ min_items }) => {
  const page = getPage();
  const patterns = await page.evaluate(`(() => {
    // On an SVG element className is an SVGAnimatedString, not a string, so
    // .split() throws and takes the whole detection down — which is exactly what
    // happened on the first real news site this was pointed at.
    function clsOf(el) {
      var c = el && el.className;
      if (typeof c === 'string') return c;
      return (el && el.getAttribute && el.getAttribute('class')) || '';
    }
    // Count children with same tag+class per parent
    var candidates = [];
    var parents = document.querySelectorAll('main, [role="main"], section, div, ul, ol, tbody');
    for (var p = 0; p < parents.length; p++) {
      var parent = parents[p];
      var childMap = {};
      for (var c = 0; c < parent.children.length; c++) {
        var child = parent.children[c];
        var key = child.tagName;
        var childCls = clsOf(child);
        if (childCls) key += '.' + childCls.split(' ').filter(function(c){return c.length>0}).slice(0,2).join('.');
        if (!childMap[key]) childMap[key] = { count: 0, tag: child.tagName.toLowerCase(), cls: childCls, sample: '' };
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
                var tCls = clsOf(texts[t]);
                if (tCls) tSel += '.' + tCls.split(' ').filter(function(c){return c.length>0&&c.length<40}).slice(0,1).join('.');
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

regTool("extract_structured", "Extract structured data from repeated elements (cards, rows, listings). Auto-deduplicates, filters empty items, extracts direct text only. Use detect_content_pattern first to find correct selectors.", {
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
    var containerSel = ${jsStr(container_selector)};
    var allContainers = document.querySelectorAll(containerSel);
    var containers = [];
    for (var c = 0; c < allContainers.length; c++) {
      var isNested = false;
      var parent = allContainers[c].parentElement;
      while (parent) {
        if (parent.matches && parent.matches(containerSel)) {
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
    var dedup = ${jsStr(deduplicate_by)};

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

regTool("extract_table", "Extract data from an HTML table as JSON array.", {
  selector: z.string().default("table").describe("CSS selector for the table"),
  limit: z.number().default(100).describe("Max rows"),
}, async ({ selector, limit }) => {
  const page = getPage();
  const results = await page.evaluate(`(() => {
    var table = document.querySelector(${jsStr(selector)});
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

regTool("scrape_page", "Smart page scraper — auto-detect and extract main content, links, metadata. Strips nav/footer noise.", {
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

// ── Tools: Compound (reduce round-trips) ───────────────────────────────────

regTool(
  "wait_and_snapshot",
  "Wait for selector/text then return snapshot. Combines wait_for + browser_snapshot in one call.",
  {
    selector: z.string().default("").describe("CSS selector to wait for"),
    text: z.string().default("").describe("Text to wait for"),
    state: z.enum(["visible", "hidden", "attached", "detached"]).default("visible"),
    timeout: z.number().default(10000),
  },
  async ({ selector, text, state, timeout }) => {
    const page = getPage();
    if (selector) {
      await page.locator(selector).first().waitFor({ state, timeout });
    } else if (text) {
      await page.getByText(text).first().waitFor({ state, timeout });
    }
    const snap = await snapshotPage(page);
    return { content: [{ type: "text", text: snap }] };
  }
);

regTool("back_and_snapshot", "Navigate back + return snapshot.", {}, async () => {
  const page = getPage();
  await page.goBack({ waitUntil: "commit", timeout: 15000 });
  await waitReady(page, "domcontentloaded", 15000);
  await page.waitForTimeout(500);
  const snap = await snapshotPage(page);
  return { content: [{ type: "text", text: snap }] };
});

regTool("reload_and_snapshot", "Reload page + return snapshot.", {}, async () => {
  const page = getPage();
  await page.reload({ waitUntil: "commit", timeout: 15000 });
  await waitReady(page, "domcontentloaded", 15000);
  await page.waitForTimeout(500);
  const snap = await snapshotPage(page);
  return { content: [{ type: "text", text: snap }] };
});

regTool(
  "click_and_snapshot",
  "Click element by ref + wait + return snapshot. Perfect for buttons that trigger navigation/dialog.",
  {
    ref: z.string().describe("Element ref from browser_snapshot"),
    wait_ms: z.number().default(1500).describe("Wait after click before snapshot"),
  },
  async ({ ref, wait_ms }) => {
    const page = getPage();
    const mode = await clickWithFallback(refLocator(page, ref));
    await page.waitForTimeout(wait_ms);
    const snap = await snapshotPage(page);
    return { content: [{ type: "text", text: (mode === "real" ? "" : `NOTE:${clickNote(mode)}\n\n`) + snap }] };
  }
);

// ── Tools: Smart Selectors (no snapshot needed) ────────────────────────────

regTool(
  "find_by_text",
  "Find elements by visible text — returns EVERY match (total + a ref and ancestor path per candidate), so you can tell whether the one you want is really the one you'd click. Skip browser_snapshot when you know the text.",
  {
    text: z.string().describe("Visible text to search for"),
    exact: z.boolean().default(true),
    within: z.string().default("").describe('Limit the search: "@dialog", "ref:e5", or a CSS selector.'),
    limit: z.number().default(8).describe("Max candidates to describe."),
  },
  async ({ text, exact, within, limit }) => {
    const page = getPage();
    const scope = within ? ` within=${within}` : "";
    let loc: any;
    try {
      loc = scopeRoot(page, within).getByText(text, { exact });
    } catch (e: any) {
      return { content: [{ type: "text", text: `Invalid within=${within}: ${e?.message || e}` }], isError: true };
    }
    const { total, items } = await describeMatches(loc, Math.max(1, limit));
    if (total === 0) {
      return { content: [{ type: "text", text: `No element found with text "${text}"${scope}` }] };
    }
    return {
      content: [{ type: "text", text: `${total} match(es) for text="${text}"${scope}${total > 1 ? " — pick deliberately, don't assume the first" : ""}:\n${candidateList(total, items)}` }],
    };
  }
);

regTool(
  "find_by_label",
  "Find input element by its label text (<label>). Returns ref + how many matched.",
  {
    label: z.string().describe("Label text (e.g. 'Email', 'Password')"),
    within: z.string().default("").describe('Limit the search: "@dialog", "ref:e5", or a CSS selector.'),
  },
  async ({ label, within }) => {
    const page = getPage();
    let loc: any;
    try {
      loc = scopeRoot(page, within).getByLabel(label);
    } catch (e: any) {
      return { content: [{ type: "text", text: `Invalid within=${within}: ${e?.message || e}` }], isError: true };
    }
    const count = await loc.count();
    if (count === 0) {
      return { content: [{ type: "text", text: `No input found with label "${label}"${within ? ` within=${within}` : ""}` }] };
    }
    if (count > 1) {
      const { total, items } = await describeMatches(loc);
      return { content: [{ type: "text", text: `${total} inputs match label "${label}" — choose one by ref:\n${candidateList(total, items)}` }] };
    }
    const info = await loc.first().evaluate((el: any) => {
      const ref = 'l' + (Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36));
      el.setAttribute('data-mcp-ref', ref);
      return {
        ref,
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        name: el.name || '',
        placeholder: el.placeholder || '',
        value: el.value || '',
      };
    });
    return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
  }
);

regTool(
  "find_by_placeholder",
  "Find input by placeholder text. Returns ref + how many matched.",
  {
    placeholder: z.string(),
    within: z.string().default("").describe('Limit the search: "@dialog", "ref:e5", or a CSS selector.'),
  },
  async ({ placeholder, within }) => {
    const page = getPage();
    let loc: any;
    try {
      loc = scopeRoot(page, within).getByPlaceholder(placeholder);
    } catch (e: any) {
      return { content: [{ type: "text", text: `Invalid within=${within}: ${e?.message || e}` }], isError: true };
    }
    const count = await loc.count();
    if (count === 0) {
      return { content: [{ type: "text", text: `No input with placeholder "${placeholder}"${within ? ` within=${within}` : ""}` }] };
    }
    if (count > 1) {
      const { total, items } = await describeMatches(loc);
      return { content: [{ type: "text", text: `${total} inputs match placeholder "${placeholder}" — choose one by ref:\n${candidateList(total, items)}` }] };
    }
    const info = await loc.first().evaluate((el: any) => {
      const ref = 'p' + (Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36));
      el.setAttribute('data-mcp-ref', ref);
      return {
        ref, tag: el.tagName.toLowerCase(), type: el.type || '', placeholder: el.placeholder || '',
      };
    });
    return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
  }
);

// ── Tools: Cookie Portability ──────────────────────────────────────────────

regTool(
  "cookie_export",
  "Export all cookies as JSON string. Use with cookie_import to transfer session.",
  {
    domain: z.string().default("").describe("Filter by domain (empty = all)"),
  },
  async ({ domain }) => {
    if (!S.browserContext) throw new Error("Browser not running. Call browser_launch first.");
    let cookies = await S.browserContext.cookies();
    if (domain) cookies = cookies.filter(c => c.domain.includes(domain));
    return { content: [{ type: "text", text: JSON.stringify(cookies, null, 2) }] };
  }
);

regTool(
  "cookie_import",
  "Import cookies from JSON (from cookie_export). Restores session state.",
  {
    cookies_json: z.string().describe("JSON array of cookies"),
  },
  async ({ cookies_json }) => {
    if (!S.browserContext) throw new Error("Browser not running. Call browser_launch first.");
    let cookies: any[];
    try {
      cookies = JSON.parse(cookies_json);
      if (!Array.isArray(cookies)) throw new Error("not an array");
    } catch (e: any) {
      return { content: [{ type: "text", text: `Invalid cookies JSON: ${e.message}` }] };
    }
    await S.browserContext.addCookies(cookies);
    return { content: [{ type: "text", text: `Imported ${cookies.length} cookies.` }] };
  }
);

// ── Tools: Page Stats (debug/decision) ─────────────────────────────────────

regTool(
  "page_stats",
  "Page statistics: element count, size, load metrics. Use to decide extraction strategy.",
  {},
  async () => {
    const page = getPage();
    const stats = await page.evaluate(`(() => {
      var all = document.querySelectorAll('*').length;
      var interactive = document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"]').length;
      var images = document.querySelectorAll('img').length;
      var forms = document.querySelectorAll('form').length;
      var iframes = document.querySelectorAll('iframe').length;
      var scripts = document.querySelectorAll('script').length;
      var bodyTextLen = (document.body.innerText || '').length;
      var htmlLen = document.documentElement.outerHTML.length;
      var perf = window.performance && window.performance.timing ? {
        domComplete: window.performance.timing.domComplete - window.performance.timing.navigationStart,
        loadEnd: window.performance.timing.loadEventEnd - window.performance.timing.navigationStart,
      } : null;
      return {
        url: location.href,
        title: document.title,
        total_elements: all,
        interactive_elements: interactive,
        images: images,
        forms: forms,
        iframes: iframes,
        scripts: scripts,
        body_text_length: bodyTextLen,
        html_size: htmlLen,
        performance_ms: perf,
        recommendation: all > 3000 ? 'Use extract_structured or scrape_page (heavy page)' : 'browser_snapshot OK',
      };
    })()`);
    return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
  }
);
