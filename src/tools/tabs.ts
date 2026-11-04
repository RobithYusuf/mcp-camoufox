// Tabs, cookies, dialogs, file upload, the ChatGPT helpers and scrolling.
//
// Registered by importing this module — see src/index.ts.
import { z } from "zod";
import type { BrowserContext, Page, Dialog } from "playwright-core";
import { writeFileSync } from "fs";
import { S, getPage, dialogLog } from "../state.js";
import { maskedValue } from "../redact.js";
import { ACTION_TIMEOUT, resolveOutPath,
         refLocator,
         trackPage, gotoReady } from "../helpers.js";
import { regTool } from "../server.js";

// ── Tools: Tab Management ──────────────────────────────────────────────────

regTool("tab_list", "List all open tabs.", {}, async () => {
  const lines: string[] = [];
  for (let i = 0; i < S.pages.length; i++) {
    const a = i === S.activePage ? " (active)" : "";
    let title = "(closed)";
    try { title = await S.pages[i].title(); } catch {}
    lines.push(`  [${i}]${a} ${S.pages[i].url()} — ${title}`);
  }
  return { content: [{ type: "text", text: `Tabs (${S.pages.length}):\n${lines.join("\n")}` }] };
});

regTool("tab_new", "Open new tab.", {
  url: z.string().default("about:blank"),
}, async ({ url }) => {
  if (!S.browserContext) throw new Error("Browser not running. Call browser_launch first.");
  const page = await S.browserContext.newPage();
  // Track BEFORE navigating. newPage() also fires the context "page" event, so
  // trackPage may already have added it (it is idempotent) — but if the goto
  // below throws, the tab still exists in the browser, and doing this afterwards
  // left it unreachable: not active, and not returned to the caller.
  trackPage(page);
  S.activePage = S.pages.indexOf(page);
  if (url && url !== "about:blank") {
    try {
      await gotoReady(page, url, "domcontentloaded", 30000);
    } catch (err) {
      // Camoufox sporadically fails to commit the very first navigation on a
      // brand-new tab — the page never arrives. Retrying on the SAME page does
      // not help and a second goto while the first is in flight makes both fail,
      // so discard the wedged tab and try once on a fresh one. Only tab_new can
      // do this safely: it owns the page it just created.
      if (!/Timeout\s+\d+ms exceeded/i.test(String((err as any)?.message || err))) throw err;
      try { await page.close(); } catch {}
      const retry = await S.browserContext.newPage();
      trackPage(retry);
      S.activePage = S.pages.indexOf(retry);
      await gotoReady(retry, url, "domcontentloaded", 30000);
      return { content: [{ type: "text", text: `New tab [${S.activePage}]. URL: ${retry.url()}\n(The first attempt never committed — Camoufox does this to roughly one new tab in fifteen — so the tab was replaced.)` }] };
    }
  }
  return { content: [{ type: "text", text: `New tab [${S.activePage}]. URL: ${page.url()}` }] };
});

regTool("tab_select", "Switch to a tab by index, or by url_contains (first tab whose URL contains the substring).", {
  index: z.number().default(-1).describe("Tab index. Ignored if url_contains is set."),
  url_contains: z.string().default("").describe("Select the first tab whose URL contains this substring."),
}, async ({ index, url_contains }) => {
  if (!S.pages.length) return { content: [{ type: "text", text: "No tabs open." }], isError: true };
  let idx = index;
  if (url_contains) {
    idx = S.pages.findIndex(p => { try { return p.url().includes(url_contains); } catch { return false; } });
    if (idx < 0) {
      const list = S.pages.map((p, i) => { let u = "?"; try { u = p.url(); } catch {} return `[${i}] ${u}`; }).join("\n  ");
      return { content: [{ type: "text", text: `No tab URL contains "${url_contains}". Open tabs:\n  ${list}` }], isError: true };
    }
  }
  if (idx < 0 || idx >= S.pages.length) {
    return { content: [{ type: "text", text: `Invalid index ${idx}. Have ${S.pages.length} tabs. Pass index or url_contains.` }], isError: true };
  }
  S.activePage = idx;
  try { await S.pages[idx].bringToFront(); } catch {}
  return { content: [{ type: "text", text: `Switched to tab [${idx}]. URL: ${S.pages[idx].url()}` }] };
});

regTool("tab_close", "Close a tab by index (-1 = active), or by url_contains.", {
  index: z.number().default(-1),
  url_contains: z.string().default("").describe("Close the first tab whose URL contains this substring (overrides index)."),
}, async ({ index, url_contains }) => {
  let idx: number;
  if (url_contains) {
    idx = S.pages.findIndex(p => { try { return p.url().includes(url_contains); } catch { return false; } });
    if (idx < 0) return { content: [{ type: "text", text: `No tab URL contains "${url_contains}".` }], isError: true };
  } else {
    idx = index === -1 ? S.activePage : index;
  }
  if (idx < 0 || idx >= S.pages.length) {
    return { content: [{ type: "text", text: `Invalid index ${idx}. Have ${S.pages.length} tabs.` }], isError: true };
  }
  // Remember the active page by IDENTITY before splicing — closing a
  // lower-indexed tab shifts every later index down, so a plain
  // Math.min(S.activePage, len-1) would silently move "active" to another tab.
  const activeObj = S.pages[S.activePage];
  const page = S.pages.splice(idx, 1)[0];
  try { await page.close(); } catch {}
  if (S.pages.length === 0) {
    S.activePage = 0;
    return { content: [{ type: "text", text: "Last tab closed. The browser is still running: tab_new opens another, browser_close stops it." }] };
  }
  const reFound = S.pages.indexOf(activeObj);
  // If we closed the active tab itself, fall back to whatever took its slot.
  S.activePage = reFound >= 0 ? reFound : Math.min(idx, S.pages.length - 1);
  return { content: [{ type: "text", text: `Closed tab [${idx}]. Active: [${S.activePage}] ${S.pages[S.activePage].url()}` }] };
});

// ── Tools: Cookies ─────────────────────────────────────────────────────────

regTool("cookie_list", "List cookies. Values are masked by default; reveal_values=true shows them.", {
  domain: z.string().default(""),
  reveal_values: z.boolean().default(false).describe("Show cookie values. A session cookie is a login, so they are masked by default."),
}, async ({ domain, reveal_values }) => {
  if (!S.browserContext) throw new Error("Browser not running. Call browser_launch first.");
  let cookies = await S.browserContext.cookies();
  if (domain) cookies = cookies.filter(c => c.domain.includes(domain));
  const lines = cookies.slice(0, 50).map(c => `  ${c.name}=${reveal_values ? c.value : maskedValue(c.value)}  domain=${c.domain} path=${c.path}`);
  return { content: [{ type: "text", text: lines.length ? `Cookies (${cookies.length}):\n${lines.join("\n")}` : "No cookies." }] };
});

regTool("cookie_set",
  "Set a cookie. IMPORTANT: with expires_days=0 this creates a SESSION cookie, which Firefox keeps in memory only — " +
  "it is gone after browser_close even though the profile itself persists. Pass expires_days (e.g. 30) to write a " +
  "login session that survives a relaunch.",
  {
    name: z.string(), value: z.string(), domain: z.string(), path: z.string().default("/"),
    expires_days: z.number().default(0).describe("Lifetime in days. 0 = session cookie (dies with the browser)."),
    http_only: z.boolean().default(false).describe("Set the HttpOnly flag (hides it from page JS, like a real auth cookie)."),
    secure: z.boolean().default(false).describe("Set the Secure flag (HTTPS only). Required when same_site='None'."),
    same_site: z.enum(["Lax", "Strict", "None"]).default("Lax"),
  },
  async ({ name, value, domain, path, expires_days, http_only, secure, same_site }) => {
    if (!S.browserContext) throw new Error("Browser not running. Call browser_launch first.");
    const cookie: any = { name, value, domain, path, httpOnly: http_only, secure, sameSite: same_site };
    // Playwright: expires is epoch SECONDS; -1 (or omitted) means session cookie.
    if (expires_days > 0) cookie.expires = Math.floor(Date.now() / 1000 + expires_days * 86400);
    if (same_site === "None" && !secure) {
      return { content: [{ type: "text", text: "same_site='None' requires secure=true — browsers reject SameSite=None without Secure." }], isError: true };
    }
    await S.browserContext.addCookies([cookie]);
    const life = expires_days > 0
      ? `expires in ${expires_days}d (survives browser_close)`
      : "SESSION cookie — will be LOST on browser_close; pass expires_days to persist";
    return { content: [{ type: "text", text: `Cookie set: ${name}=${maskedValue(value)} domain=${domain} — ${life}` }] };
  });

regTool("cookie_delete", "Delete cookies by exact name and/or domain (a domain also covers its subdomains, never a look-alike such as notexample.com). Both empty = clear all. The count is read back from the browser.", {
  name: z.string().default(""), domain: z.string().default(""),
}, async ({ name, domain }) => {
  if (!S.browserContext) throw new Error("Browser not running. Call browser_launch first.");
  const ctx = S.browserContext;
  if (!name && !domain) {
    await ctx.clearCookies();
    const left = (await ctx.cookies()).length;
    if (left) return { content: [{ type: "text", text: `Tried to clear all cookies, but ${left} remain.` }], isError: true };
    return { content: [{ type: "text", text: "All cookies cleared." }] };
  }
  const want = domain.replace(/^\./, "").toLowerCase();
  const matches = (c: any) => {
    if (name && c.name !== name) return false;
    if (!want) return true;
    const host = String(c.domain).replace(/^\./, "").toLowerCase();
    return host === want || host.endsWith("." + want);
  };
  const before = await ctx.cookies();
  for (const c of before.filter(matches)) {
    await ctx.clearCookies({ name: c.name, domain: c.domain, path: c.path });
  }
  const after = await ctx.cookies();
  const left = after.filter(matches).length;
  const gone = before.length - after.length;
  if (left) return { content: [{ type: "text", text: `Deleted ${gone} cookie(s), but ${left} matching cookie(s) are still there.` }], isError: true };
  return { content: [{ type: "text", text: `Deleted ${gone} cookie(s).` }] };
});

// ── Tools: Dialog ──────────────────────────────────────────────────────────

regTool("dialog_handle", "Set the answer for the next alert/confirm/prompt on ANY tab, including tabs opened later. Dialogs nobody armed are dismissed at once and named in the reply of the call they appeared in, so arm this BEFORE the action that opens one.", {
  action: z.enum(["accept", "dismiss"]).default("accept"),
  prompt_text: z.string().default(""),
}, async ({ action, prompt_text }) => {
  if (!S.pages.length) throw new Error("Browser not running. Call browser_launch first.");
  S.oneShotDialog = { action, promptText: prompt_text };
  // A dialog cannot be left open and answered later: the page is blocked until it is
  // answered. So say when this arrived too late for one that just went by.
  const last = dialogLog.at(-1);
  const missed = last && Date.now() - last.at < 10000
    ? `\n⚠ A ${last.type} dialog ("${last.message}") already went by ${Math.round((Date.now() - last.at) / 1000)}s ago and was ${last.answer}. This applies to the next one, so repeat the action.`
    : "";
  return { content: [{ type: "text", text: `Next dialog will be ${action}'d (any tab, including tabs opened later)${missed}` }] };
});

// ── Tools: File Upload ─────────────────────────────────────────────────────

regTool("upload_file", "Upload file to file input.", {
  ref: z.string(), file_path: z.string(),
}, async ({ ref, file_path }) => {
  const page = getPage();
  await refLocator(page, ref).setInputFiles(file_path, { timeout: ACTION_TIMEOUT });
  return { content: [{ type: "text", text: `Uploaded ${file_path} to ref=${ref}` }] };
});

// ── Tool: ChatGPT image generation (high-level, end-to-end) ──────────────────
regTool(
  "chatgpt_generate_image",
  "Generate or edit an image on chatgpt.com end-to-end and save it to disk in ONE call. Opens a fresh chat, optionally uploads reference images (e.g. a brand logo), submits the prompt, waits for the generated image to finish, then writes the result PNG to output_path. Requires an authenticated chatgpt.com session (import cookies first via cookie_import). Returns the saved path and pixel dimensions. Note: chatgpt image generation is slow (~60-120s) — set timeout_ms accordingly.",
  {
    prompt: z.string().describe("Text prompt for image generation/editing."),
    output_path: z.string().describe("Absolute path to write the resulting PNG."),
    image_paths: z.array(z.string()).default([]).describe("Optional reference image file paths to upload before prompting (e.g. a logo)."),
    timeout_ms: z.number().default(240000).describe("Max ms to wait for the generated image."),
  },
  async ({ prompt, output_path, image_paths, timeout_ms }) => {
    const page = getPage();
    // 1) fresh chat
    await gotoReady(page, "https://chatgpt.com/", "domcontentloaded", 60000);
    await page.waitForSelector("#prompt-textarea", { timeout: 30000 });
    // dismiss blocking modals (e.g. subscription-failure) that intercept clicks
    try { await page.evaluate(`(() => { const m = document.getElementById('modal-subscription-failure'); if (m) m.remove(); document.querySelectorAll('div[data-state="open"].z-50').forEach(e => e.remove()); })()`); } catch {}
    try { await page.keyboard.press("Escape"); } catch {}
    // 2) upload reference images (e.g. logo) to the hidden file input
    if (image_paths.length > 0) {
      await page.locator('input[type="file"]').first().setInputFiles(image_paths, { timeout: ACTION_TIMEOUT });
      await page.waitForTimeout(2500); // let thumbnails attach
    }
    // 3) type prompt + submit
    const editor = page.locator("#prompt-textarea");
    await editor.click();
    await page.keyboard.insertText(prompt);
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
    // 4) wait for a finished assistant image (>=1000px, loaded)
    const READY = `(() => { const imgs = Array.from(document.querySelectorAll('main img')).filter(i => !i.closest('[data-message-author-role="user"]')); return imgs.some(i => i.complete && i.naturalWidth >= 1000 && i.naturalHeight >= 1000); })()`;
    await page.waitForFunction(READY, undefined, { timeout: timeout_ms, polling: 2000 });
    // 5) settle until the largest image src stops changing (preview -> final)
    let lastSrc = "";
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(2500);
      const cur = await page.evaluate(`(() => { const imgs = Array.from(document.querySelectorAll('main img')).filter(i => !i.closest('[data-message-author-role="user"]')).filter(i => i.complete && i.naturalWidth >= 1000); imgs.sort((a,b)=>(b.naturalWidth*b.naturalHeight)-(a.naturalWidth*a.naturalHeight)); return imgs[0] ? imgs[0].src : ""; })()`) as string;
      if (cur && cur === lastSrc) break;
      lastSrc = cur;
    }
    // 6) fetch the largest assistant image as a data URL, write to disk
    const dataUrl = await page.evaluate(`(async () => { const imgs = Array.from(document.querySelectorAll('main img')).filter(i => !i.closest('[data-message-author-role="user"]')).filter(i => i.complete && i.naturalWidth >= 1000); imgs.sort((a,b)=>(b.naturalWidth*b.naturalHeight)-(a.naturalWidth*a.naturalHeight)); const big = imgs[0]; if (!big) return null; const r = await fetch(big.src); const b = await r.blob(); return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }); })()`) as string | null;
    if (!dataUrl || typeof dataUrl !== "string" || dataUrl.indexOf(",") < 0) {
      throw new Error("Generated image not found / could not be fetched after wait.");
    }
    const dims = await page.evaluate(`(() => { const imgs = Array.from(document.querySelectorAll('main img')).filter(i => !i.closest('[data-message-author-role="user"]')).filter(i => i.complete && i.naturalWidth >= 1000); imgs.sort((a,b)=>(b.naturalWidth*b.naturalHeight)-(a.naturalWidth*a.naturalHeight)); const big = imgs[0]; return big ? (big.naturalWidth + "x" + big.naturalHeight) : "?"; })()`) as string;
    const buf = Buffer.from(dataUrl.split(",")[1], "base64");
    const target = resolveOutPath(output_path);
    writeFileSync(target, buf);
    return { content: [{ type: "text", text: `Saved ${target} (${dims}, ${buf.length} bytes)` }] };
  }
);

regTool(
  "chatgpt_generate_batch",
  "Generate MANY images on chatgpt.com IN PARALLEL (one tab per job, fire-all-then-collect) and save each to disk. Submits every job first WITHOUT waiting, then waits for all generations concurrently — far faster than sequential. For a CONSISTENT feed set, pass shared_image_paths (e.g. [logo] and/or a style-reference image like a previously-generated hero) uploaded to EVERY tab, plus style_suffix (a shared style spec) appended to every prompt. Requires an authenticated chatgpt.com session (import cookies first). Returns per-job results (saved path / ok / bytes / error).",
  {
    jobs: z.array(z.object({ prompt: z.string(), output_path: z.string() })).describe("Per-image jobs: each has a prompt and an output PNG path."),
    shared_image_paths: z.array(z.string()).default([]).describe("Reference images uploaded to EVERY tab (e.g. [logoPath, styleRefPath]) — key for visual consistency."),
    style_suffix: z.string().default("").describe("Shared style spec text appended to every prompt (exact colors, typography, layout, mood) for consistency."),
    timeout_ms: z.number().default(300000).describe("Max ms to wait for each image to finish."),
    stagger_ms: z.number().default(900).describe("Delay between submitting each tab (avoids UI/anti-bot races)."),
  },
  async ({ jobs, shared_image_paths, style_suffix, timeout_ms, stagger_ms }) => {
    if (!S.browserContext) throw new Error("Browser not running. Call browser_launch first.");
    const NOTUSER = `Array.from(document.querySelectorAll('main img')).filter(i => !i.closest('[data-message-author-role="user"]'))`;
    const submit = async (page: Page, prompt: string) => {
      await gotoReady(page, "https://chatgpt.com/", "domcontentloaded", 60000);
      await page.waitForSelector("#prompt-textarea", { timeout: 30000 });
      try { await page.evaluate(`(() => { const m=document.getElementById('modal-subscription-failure'); if(m)m.remove(); document.querySelectorAll('div[data-state="open"].z-50').forEach(e=>e.remove()); })()`); } catch {}
      if (shared_image_paths.length > 0) {
        await page.locator('input[type="file"]').first().setInputFiles(shared_image_paths, { timeout: ACTION_TIMEOUT });
        await page.waitForTimeout(2500);
      }
      await page.locator("#prompt-textarea").click();
      await page.keyboard.insertText(prompt + (style_suffix ? "\n\n" + style_suffix : ""));
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");
    };
    const collect = async (page: Page, output_path: string): Promise<number> => {
      const READY = `(() => { const imgs = ${NOTUSER}; return imgs.some(i => i.complete && i.naturalWidth >= 1000 && i.naturalHeight >= 1000); })()`;
      await page.waitForFunction(READY, undefined, { timeout: timeout_ms, polling: 2000 });
      let last = "";
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(2500);
        const cur = await page.evaluate(`(() => { const imgs = ${NOTUSER}.filter(i => i.complete && i.naturalWidth >= 1000); imgs.sort((a,b)=>(b.naturalWidth*b.naturalHeight)-(a.naturalWidth*a.naturalHeight)); return imgs[0] ? imgs[0].src : ""; })()`) as string;
        if (cur && cur === last) break;
        last = cur;
      }
      const dataUrl = await page.evaluate(`(async () => { const imgs = ${NOTUSER}.filter(i => i.complete && i.naturalWidth >= 1000); imgs.sort((a,b)=>(b.naturalWidth*b.naturalHeight)-(a.naturalWidth*a.naturalHeight)); const big = imgs[0]; if (!big) return null; const r = await fetch(big.src); const b = await r.blob(); return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }); })()`) as string | null;
      if (!dataUrl || typeof dataUrl !== "string" || dataUrl.indexOf(",") < 0) throw new Error("image not found");
      const buf = Buffer.from(dataUrl.split(",")[1], "base64");
      writeFileSync(resolveOutPath(output_path), buf);
      return buf.length;
    };
    // Phase 1: open a tab per job and SUBMIT (staggered), without waiting for generation
    const entries: { page: Page; output_path: string; submitErr: string | null }[] = [];
    for (const job of jobs) {
      const page = await S.browserContext.newPage();
      let submitErr: string | null = null;
      try { await submit(page, job.prompt); } catch (e) { submitErr = String(e); }
      entries.push({ page, output_path: job.output_path, submitErr });
      await page.waitForTimeout(stagger_ms);
    }
    // Phase 2: wait for ALL generations concurrently + save
    const results = await Promise.all(entries.map(async (en) => {
      if (en.submitErr) return { output_path: en.output_path, ok: false, error: "submit: " + en.submitErr };
      try { const bytes = await collect(en.page, en.output_path); return { output_path: en.output_path, ok: true, bytes }; }
      catch (e) { return { output_path: en.output_path, ok: false, error: String(e) }; }
    }));
    for (const en of entries) { try { await en.page.close(); } catch {} }
    const okCount = results.filter(r => r.ok).length;
    return { content: [{ type: "text", text: `Batch done: ${okCount}/${jobs.length} succeeded.\n` + JSON.stringify(results, null, 2) }] };
  }
);

// ── Tools: Scroll ──────────────────────────────────────────────────────────

regTool("scroll", "Scroll the page.", {
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
  const pos = `JSON.stringify([window.scrollX, window.scrollY])`;
  const before = JSON.parse(await page.evaluate(pos) as string);
  await page.evaluate(`window.scrollBy({ left: ${dx}, top: ${dy}, behavior: "instant" })`);
  await page.waitForTimeout(100);
  const after = JSON.parse(await page.evaluate(pos) as string);
  const moved = Math.round(Math.abs(after[0] - before[0]) + Math.abs(after[1] - before[1]));
  // Report the distance covered: the end of the page stops a scroll short.
  return { content: [{ type: "text", text: moved === 0
    ? `Did not move: the page is already at its ${direction} limit or cannot scroll (moved 0px). Asked for ${amount}px.`
    : `Scrolled ${direction} ${moved}px${moved !== amount ? ` (asked for ${amount}px; the page ended first)` : ""}.` }] };
});
