// Core browser tools + the regressions that cost us real releases.
import { startServer, fixtureServer, html, refOf, runner, until } from "./harness.mjs";

const PORT = 39501;
const CARDS = [1, 2, 3, 4].map(i =>
  `<li class="card"><h3>Card ${i}</h3><span class="price">${i}00</span><a href="/c${i}">link${i}</a></li>`).join("");

const PAGE = html(`
<header><nav><a href="/nav">NavNoise</a></nav></header>
<main>
<h1>Main Heading</h1><h2>Sub A</h2>
<form id="f">
  <label for="email">Email Address</label><input id="email" name="email" type="email">
  <label for="pw">Password</label><input id="pw" name="password" type="password">
  <input id="num" type="number"><select id="sel"><option value="a">A</option><option value="b">B</option></select>
  <input id="chk" type="checkbox"><input id="file" type="file">
  <button id="sub" type="button">Do Nothing</button>
</form>
<button id="hdrCancel" type="button" onclick="document.getElementById('who').textContent='header'">Cancel</button>
<div role="dialog" id="dlg"><button type="button" onclick="document.getElementById('who').textContent='dialog'">Cancel</button></div>
<div id="who">none</div>
<button id="ask" type="button" onclick="document.getElementById('out').textContent=confirm('sure?')?'yes':'no'">Ask</button>
<div id="out">none</div>
<ul id="cards">${CARDS}</ul>
<table id="tbl"><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>Apple</td><td>3</td></tr><tr><td>Banana</td><td>5</td></tr></tbody></table>
<iframe name="myframe" src="/frame" width="200" height="100"></iframe>
<p id="lorem">${"Lorem ipsum dolor sit amet consectetur. ".repeat(60)}</p>
</main>
<footer>FooterNoise</footer>
<script>setTimeout(function(){ throw new Error('page-boom'); }, 50);</script>`, "Core Fixture");

export default async function run() {
  const { check, report } = runner("suite-core");
  let fx = null, S = null;
  try {
  fx = await fixtureServer({
    "/frame": (q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<title>F</title><div id='fd'>frame-data</div>"); },
    "/second": (q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<title>Second</title><h1>Second Page</h1>"); },
    // A strict CSP, because every fixture here used to allow eval and so never
    // represented a real site. waitReady polled with page.waitForFunction, whose
    // predicate runs through eval() — 94 checks passed while navigation was in
    // fact broken on news.ycombinator.com, github.com and MDN.
    "/csp": (q, r) => {
      r.writeHead(200, { "content-type": "text/html", "content-security-policy": "default-src 'self'; script-src 'self'" });
      r.end("<title>CSP</title><h1 id='c'>CSP Page</h1>");
    },
    "/api.json": (q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end('{"msg":"hello-api"}'); },
    "*": (q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(PAGE); },
  }, PORT);
  S = await startServer();
  const c = S.call;

  await check("browser_launch (fresh profile)", async () => {
    const t = await c("browser_launch", { url: fx.url, headless: true, fresh_profile: true });
    return [t.includes("Browser launched") && t.includes("Viewport:"), t.split("\n").pop()];
  });
  await check("reset_profile refuses while browser up", async () => {
    const t = await c("reset_profile"); return [t.includes("Refused"), t.slice(0, 60)];
  });

  let snap = await c("browser_snapshot");
  await check("browser_snapshot lists refs", async () => [snap.includes("ref=e0"), snap.split("\n")[3]]);
  await check("snapshot roles filter + pagination", async () => {
    const a = await c("browser_snapshot", { roles: ["button"] });
    const b = await c("browser_snapshot", { offset: 2, limit: 3 });
    return [a.includes("matched") && b.includes("showing 3"), b.split("\n")[3]];
  });

  // v0.8.0 regression: fill APPENDED on email/number inputs
  await check("fill replaces on email input", async () => {
    const r = refOf(snap, "type=email");
    await c("fill", { ref: r, value: "first@x.com" });
    await c("fill", { ref: r, value: "second@x.com" });
    const v = await c("evaluate", { expression: "document.getElementById('email').value" });
    return [v === "second@x.com", v];
  });
  await check("fill replaces on number input", async () => {
    await c("evaluate", { expression: "document.getElementById('num').setAttribute('data-mcp-ref','numref'); 'ok'" });
    await c("fill", { ref: "numref", value: "111" });
    await c("fill", { ref: "numref", value: "222" });
    const v = await c("evaluate", { expression: "document.getElementById('num').value" });
    return [v === "222", v];
  });
  // v0.9.6 regression: snapshot printed password values
  await check("snapshot masks password values", async () => {
    await c("evaluate", { expression: "document.getElementById('pw').value='SuperSecret123'; 'ok'" });
    const s2 = await c("browser_snapshot");
    const ins = await c("inspect_element", { ref: refOf(s2, "type=password") });
    return [!s2.includes("SuperSecret123") && !ins.includes("SuperSecret123"), "snapshot+inspect masked"];
  });

  await check("select_option / check / uncheck", async () => {
    const s2 = await c("browser_snapshot");
    await c("select_option", { ref: refOf(s2, "[select]"), value: "b" });
    await c("check", { ref: refOf(s2, "type=checkbox") });
    const on = await c("evaluate", { expression: "String(document.getElementById('chk').checked)" });
    await c("uncheck", { ref: refOf(s2, "type=checkbox") });
    const off = await c("evaluate", { expression: "document.getElementById('sel').value + ':' + document.getElementById('chk').checked" });
    return [on === "true" && off === "b:false", off];
  });

  // v0.8.0 regression: click_text silently took the first match
  await check("click_text refuses an ambiguous match", async () => {
    const t = await c("click_text", { text: "Cancel" });
    const who = await c("evaluate", { expression: "document.getElementById('who').textContent" });
    return [t.startsWith("IS_ERROR") && t.includes("Ambiguous") && who === "none", `nothing clicked (who=${who})`];
  });
  await check("click_text within=@dialog picks the dialog", async () => {
    await c("evaluate", { expression: "document.getElementById('who').textContent='none'; 'ok'" });
    await c("click_text", { text: "Cancel", within: "@dialog" });
    const who = await c("evaluate", { expression: "document.getElementById('who').textContent" });
    return [who === "dialog", who];
  });
  await check("click_text index=0 picks the header", async () => {
    await c("evaluate", { expression: "document.getElementById('who').textContent='none'; 'ok'" });
    await c("click_text", { text: "Cancel", index: 0 });
    const who = await c("evaluate", { expression: "document.getElementById('who').textContent" });
    return [who === "header", who];
  });
  await check("find_by_text lists every candidate", async () => {
    const t = await c("find_by_text", { text: "Cancel" });
    return [t.includes("2 match(es)") && (t.match(/ref=m/g) || []).length === 2, t.split("\n")[0]];
  });

  await check("dialog_handle accepts a confirm", async () => {
    await c("dialog_handle", { action: "accept" });
    const s2 = await c("browser_snapshot");
    await c("click", { ref: refOf(s2, '"Ask"') });
    const v = await c("evaluate", { expression: "document.getElementById('out').textContent" });
    return [v === "yes", `out=${v}`];
  });
  await check("dialog_auto_handle survives repeated dialogs", async () => {
    await c("dialog_auto_handle", { action: "accept" });
    const s2 = await c("browser_snapshot"); const r = refOf(s2, '"Ask"');
    await c("evaluate", { expression: "document.getElementById('out').textContent='none'; 'ok'" });
    await c("click", { ref: r });
    const first = await c("evaluate", { expression: "document.getElementById('out').textContent" });
    await c("evaluate", { expression: "document.getElementById('out').textContent='none'; 'ok'" });
    await c("click", { ref: r });
    const second = await c("evaluate", { expression: "document.getElementById('out').textContent" });
    await c("dialog_auto_handle", { enabled: false });
    return [first === "yes" && second === "yes", `${first}/${second}`];
  });

  await check("extract_table", async () => {
    const j = JSON.parse(await c("extract_table", { selector: "#tbl" }));
    return [j.rows.length === 2 && j.rows[0].Name === "Apple", JSON.stringify(j.rows[0])];
  });
  await check("extract_structured", async () => {
    const j = JSON.parse(await c("extract_structured", {
      container_selector: "li.card",
      fields: [{ name: "title", selector: "h3" }, { name: "price", selector: ".price" }, { name: "url", selector: "a", attribute: "href" }],
    }));
    return [j.unique_extracted === 4 && j.items[0].title === "Card 1", `extracted=${j.unique_extracted}`];
  });
  await check("scrape_page strips nav/footer", async () => {
    const j = JSON.parse(await c("scrape_page", { max_text_length: 2000 }));
    return [j.title === "Core Fixture" && j.truncated === true && !j.text.includes("FooterNoise"), `truncated=${j.truncated}`];
  });
  await check("get_links filter + quote-safe filter", async () => {
    const a = await c("get_links", { filter: "/c1" });
    const b = await c("get_links", { filter: 'a"b\\c' });
    return [a.includes("Links (1)") && b.includes("Links (0)"), a.split("\n")[0]];
  });
  await check("localstorage roundtrip with a hostile key", async () => {
    const k = 'a"b\\c\nd';
    await c("localstorage_set", { key: k, value: 'v"1' });
    const t = await c("localstorage_get", { key: k });
    return [t.endsWith('=v"1'), JSON.stringify(t)];
  });
  await check("sessionstorage set/get/clear", async () => {
    await c("sessionstorage_set", { key: "s", value: "1" });
    const got = await c("sessionstorage_get", { key: "s" });
    await c("sessionstorage_clear");
    const after = await c("sessionstorage_get", {});
    return [got === "s=1" && after.trim() === "{}", after.trim()];
  });

  await check("frames: list + evaluate by name", async () => {
    const l = await c("list_frames");
    const v = await c("frame_evaluate", { frame_name: "myframe", expression: "document.getElementById('fd').textContent" });
    return [l.includes("myframe") && v === "frame-data", v];
  });
  await check("get_page_errors captures the page throw", async () => {
    await c("reload");
    const t = await until(async () => { const x = await c("get_page_errors"); return x.includes("page-boom") && x; }, 5000)
      || await c("get_page_errors");
    return [t.includes("page-boom"), t.replace(/\s+/g, " ").slice(0, 70)];
  });
  await check("console capture", async () => {
    await c("console_start");
    await c("evaluate", { expression: "console.log('hello-console'); 'ok'" });
    const t = await until(async () => { const x = await c("console_get"); return x.includes("hello-console") && x; }, 5000)
      || await c("console_get");
    return [t.includes("hello-console"), t.split("\n").pop()];
  });
  await check("network capture + detail + valid HAR", async () => {
    await c("network_start", { capture_bodies: true });
    await c("evaluate", { expression: "fetch('/api.json'); 'ok'" });
    const det = await until(async () => { const x = await c("network_get_detail", { url: "api.json" }); return x.includes("hello-api") && x; }, 6000)
      || await c("network_get_detail", { url: "api.json" });
    const har = await c("export_har", { path: "/tmp/mcpc-test.har" });
    const j = JSON.parse((await import("fs")).readFileSync("/tmp/mcpc-test.har", "utf8"));
    const e = j.log.entries[0];
    const ok = j.log.version === "1.2" && ["startedDateTime", "time", "request", "response", "cache", "timings"].every(k => k in e);
    return [det.includes("hello-api") && ok, `har entries=${j.log.entries.length}`];
  });

  await check("tab_close keeps the SAME active tab", async () => {
    for (const q of ["B", "C", "D"]) await c("tab_new", { url: `${fx.url}/second?${q}` });
    // Wait until every tab actually reports its URL. tab_new returns once goto
    // resolves, but under load a tab was occasionally still uncommitted when the
    // next check searched for it by url_contains — the failure then looked like a
    // tab_select bug rather than a racing fixture.
    for (let i = 0; i < 20; i++) {
      const list = await c("tab_list");
      if (["?B", "?C", "?D"].every(q => list.includes(q))) break;
      await new Promise(r => setTimeout(r, 200));
    }
    await c("tab_select", { index: 1 });
    await c("tab_close", { index: 0 });
    const list = await c("tab_list");
    const active = list.split("\n").find(l => l.includes("(active)")) || "";
    return [active.includes("?B"), active.trim()];
  });
  await check("tab_select/close by url_contains", async () => {
    const a = await c("tab_select", { url_contains: "?D" });
    const b = await c("tab_close", { url_contains: "?C" });
    // report BOTH sides: a failure that only prints the second call is undiagnosable
    return [a.includes("Switched") && b.includes("Closed tab"), `select→ ${a.slice(0, 60)} | close→ ${b.slice(0, 60)}`];
  });

  await check("navigate works on a page with a strict CSP", async () => {
    const t = await c("navigate", { url: `${fx.url}/csp` });
    const h = await c("evaluate", { expression: "document.getElementById('c') ? document.getElementById('c').textContent : 'NO DOM'" });
    await c("navigate", { url: fx.url });
    return [!t.startsWith("IS_ERROR") && h === "CSP Page", `${t.split("\n")[0].slice(0, 44)} | ${h}`];
  });
  await check("navigate still works past the 5th tab", async () => {
    // Camoufox stops delivering load/domcontentloaded to Juggler after the fifth
    // page in a context: measured 4 successes then 8 straight 30s timeouts. Every
    // navigation tool waited on those events, so opening five tabs broke
    // navigate/tab_new/reload/go_back for the rest of the session.
    const tags = ["T1", "T2", "T3", "T4", "T5", "T6"];
    const opened = [];
    for (const q of tags) {
      const r = await c("tab_new", { url: `${fx.url}/second?${q}` });
      // Distinct marker: the previous one was the word TIMEOUT, and swapping in the
      // real error text made the filter below stop matching — the check then passed
      // while a tab_new had in fact failed.
      opened.push(r.startsWith("IS_ERROR") ? `${q}:FAILED[${r.replace(/\s+/g, " ").slice(10, 80)}]` : q);
    }
    const nav = await c("navigate", { url: fx.url });
    const here = await c("evaluate", { expression: "location.pathname" });
    for (const q of tags) { try { await c("tab_close", { url_contains: `?${q}` }); } catch {} }
    const bad = opened.filter(o => o.includes(":FAILED["));
    return [!bad.length && here === "/" && !nav.startsWith("IS_ERROR"), `opened=${opened.join(",")} navigate→${here}`];
  });
  await check("tab_new keeps the tab reachable when the URL fails", async () => {
    // The tab exists in the browser the moment newPage() returns. Tracking it
    // only after a successful goto left a dead tab nobody could select or close.
    const rowsOf = t => t.split("\n").filter(l => /^\s*\[\d+\]/.test(l));
    const before = rowsOf(await c("tab_list")).length;
    const r = await c("tab_new", { url: "http://127.0.0.1:1/" });   // Firefox refuses port 1 at once
    const rows = rowsOf(await c("tab_list"));
    const active = rows.find(l => l.includes("(active)")) || "";
    // Don't assert the parked URL — Firefox may show about:blank or its own
    // blocked-port page. What matters is that the tab is tracked and selected.
    const idx = Number((active.match(/\[(\d+)\]/) || [])[1]);
    const ok = r.startsWith("IS_ERROR") && rows.length === before + 1 && !active.includes(`${fx.url}/`) && idx === before;
    try { await c("tab_close", { index: idx }); } catch {}
    await c("tab_select", { index: 0 });
    return [ok, `${r.slice(0, 34)} | tabs ${before}→${rows.length} | active=${active.trim().slice(0, 46)}`];
  });
  await check("dialog_handle covers a tab opened after it was armed", async () => {
    // The one-shot armed only the tabs open at the time, but told the persistent
    // handler to stand down globally — so a dialog on a newer tab reached no
    // handler, and a registered listener suppresses Playwright's auto-dismiss.
    // That page then blocked forever.
    await c("dialog_handle", { action: "accept" });
    await c("tab_new", { url: fx.url });
    const s2 = await c("browser_snapshot");
    await c("evaluate", { expression: "document.getElementById('out').textContent='none'; 'ok'" });
    await c("click", { ref: refOf(s2, '"Ask"') });
    const v = await c("evaluate", { expression: "document.getElementById('out').textContent" });
    try { await c("tab_close", { index: 1 }); } catch {}
    await c("tab_select", { index: 0 });
    return [v === "yes", `out=${v}`];
  });

  // The tab block above left us on /second. Come back to the fixture root and
  // PROVE we arrived — a bare navigate here raced occasionally with the tab that
  // had just been closed, and the next two checks then failed for the wrong reason.
  let navSays = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    navSays.push(await c("navigate", { url: fx.url }));
    const here = await c("evaluate", { expression: "location.pathname + '|' + (document.getElementById('tbl') ? 'has-table' : 'no-table') + '|ready=' + document.readyState + '|title=' + JSON.stringify(document.title) + '|body=' + (document.body ? document.body.innerHTML.length : -1)" });
    if (here.includes("has-table")) break;
    if (attempt === 2) {
      const tabs = await c("tab_list");
      const url = await c("get_url");
      const st = await c("server_status");
      const probe = await fx.probe(), socks = await fx.sockets();
      const fresh = await c("tab_new", { url: fx.url });
      throw new Error(`could not get back to the fixture root: ${here}\n  fixture probe: ${probe} (open sockets: ${socks})\n  fresh tab said: ${String(fresh).replace(/\n/g, " ").slice(0, 140)}\n  navigate said: ${navSays.map((n, i) => `[${i}] ${n.replace(/\n/g, " ").slice(0, 160)}`).join("\n                 ")}\n  get_url: ${url.replace(/\n/g, " ")}\n  ${tabs.replace(/\n/g, "\n  ")}`);
    }
  }
  await check("screenshot returns the image inline", async () => {
    const t = await c("screenshot", { name: "suite-core" });
    return [t.includes("[IMAGE image/png") && t.includes("saved"), t.split("\n")[0]];
  });
  await check("screenshot of one element", async () => {
    const t = await c("screenshot", { name: "suite-core-el", selector: "#tbl" });
    return [t.includes("element #tbl"), (t.split("\n")[1] || t).slice(0, 60)];
  });
  await check("save_pdf fails with an actionable message", async () => {
    const t = await c("save_pdf", { path: "/tmp/mcpc-test.pdf" });
    return [t.startsWith("IS_ERROR") && t.includes("screenshot(full_page=true)"), t.slice(0, 60)];
  });
  await check("assertions", async () => {
    const a = await c("assert_element_visible", { selector: "h1" });
    const b = await c("assert_text_present", { text: "Main Heading" });
    const d = await c("assert_url_matches", { pattern: "127.0.0.1" });
    return [a.startsWith("PASS") && b.startsWith("PASS") && d.startsWith("PASS"), "3/3 PASS"];
  });
  // a dashboard-scale page once produced a 566,000-character snapshot silently
  await check("browser_snapshot caps a huge page and says how to continue", async () => {
    await c("evaluate", { expression: "(() => { var f=document.createDocumentFragment(); for (var i=0;i<3000;i++){var b=document.createElement('button'); b.id='big'+i; b.setAttribute('aria-label','Action '+i+' with a fairly long accessible name'); b.textContent='Item '+i; f.appendChild(b);} document.body.appendChild(f); return 'ok'; })()" });
    const snap = await c("browser_snapshot");
    const ok = snap.length < 70000 && snap.includes("stopped at") && snap.includes("browser_snapshot(offset=");
    await c("reload");
    return [ok, `${snap.length} chars, continuation hint present`];
  });
  await check("browser_close reports cookie fate", async () => {
    const t = await c("browser_close");
    return [t.includes("Browser closed") && (t.includes("Cookies:") || t.includes("Temp profile removed")), t.slice(0, 80)];
  });
  await check("tools error cleanly with no browser", async () => {
    const t = await c("browser_snapshot");
    return [t.startsWith("IS_ERROR") && t.includes("Browser not running"), t.slice(0, 50)];
  });

  } finally {
    // Always release the browser: a check that throws used to skip this and leak a
    // Camoufox process into the next run, which then failed for unrelated reasons.
    try { if (S) await S.call("browser_close"); } catch {}
    if (fx) fx.close(); if (S) S.kill();
  }
  return report();
}
