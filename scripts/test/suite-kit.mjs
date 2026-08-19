// Browserless HTTP kit + the LLM-ergonomics tools.
import { startServer, fixtureServer, html, refOf, runner } from "./harness.mjs";

const PORT = 39511;
const PAGE = html(`
<nav><a href="/nav">NavNoise</a></nav>
<main>
<h1>Fixture Heading</h1>
<p>Alpha bravo charlie. The magic token is <b>XYZZY-42</b> here.</p>
<h2>Second Section</h2><ul><li>first item</li><li>second item</li></ul>
<p><a href="/target">A real link</a></p>
<form id="f">
  <label for="email">Email Address</label><input id="email" name="email" type="email" required>
  <label for="pw">Password</label><input id="pw" name="password" type="password" required minlength="8">
  <label for="nick">Nickname</label><input id="nick" name="nick" type="text">
  <button id="sub" type="button" onclick="document.getElementById('subout').textContent='submitted'">Send Form</button>
</form>
<div id="subout"></div>
<div id="wide" style="width:400px;height:60px;border:1px solid #333">wide target</div><div id="pos">none</div>
<input id="po" placeholder="paste only"><div id="pomodel">none</div>
<div id="cover" style="position:relative">
  <button id="under" type="button" style="position:absolute;left:0;top:0;width:120px;height:40px">Under</button>
  <div id="blanket" style="position:absolute;left:0;top:0;width:120px;height:40px;background:rgba(0,0,0,.02)"></div>
</div>
<div style="height:1500px"></div><div id="deep">DEEP ELEMENT</div>
</main><footer>FooterNoise</footer>
<script>
 document.getElementById('wide').addEventListener('click', function(e){
   var r=e.currentTarget.getBoundingClientRect();
   document.getElementById('pos').textContent=Math.round((e.clientX-r.left)/r.width*100)+','+Math.round((e.clientY-r.top)/r.height*100);
 });
 document.getElementById('po').addEventListener('paste', function(e){
   document.getElementById('pomodel').textContent=e.clipboardData.getData('text/plain');
 });
</script>`, "Kit Fixture");

export default async function run() {
  const { check, report } = runner("suite-kit");
  let maybeHits = 0, slowDone = false;
  const fx = await fixtureServer({
    "/api.json": (q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end('{"msg":"hello-api"}'); },
    "/echo": (q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify({ method: q.method, headers: q.headers })); },
    "/slow": (q, r) => { setTimeout(() => { slowDone = true; r.writeHead(200); r.end("late"); }, 3000); },
    "/target": (q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<title>Target</title><h1>Target Page</h1>"); },
    // a self-hosted SearXNG with `formats: [html, json]` enabled
    "/search": (q, r) => {
      const u = new URL(q.url, "http://x");
      if (u.searchParams.get("format") !== "json") { r.writeHead(200, { "content-type": "text/html" }); return r.end("<!doctype html><html>SearXNG UI</html>"); }
      r.writeHead(200, { "content-type": "application/json" });
      r.end(JSON.stringify({ query: u.searchParams.get("q"), results: [
        { title: "First hit", url: "https://example.com/a", content: "Snippet A", engine: "brave" },
        { title: "Second hit", url: "https://example.com/b", content: "Snippet B", engine: "google" },
        { title: "relative — dropped", url: "/not-absolute", content: "", engine: "x" },
      ] }));
    },
    "/maybe": (q, r) => {
      // first hit looks like a CF challenge, later hits are real: exercises escalation
      if (++maybeHits === 1) { r.writeHead(403, { "content-type": "text/html" }); return r.end("<title>Just a moment...</title>Checking your browser before accessing"); }
      r.writeHead(200, { "content-type": "text/html" });
      r.end("<title>Real</title><main><h1>Escalated OK</h1><p>" + "content ".repeat(60) + "</p></main>");
    },
    "*": (q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(PAGE); },
  }, PORT);
  const S = await startServer();
  const c = S.call;

  // ── browserless HTTP (no browser_launch yet, on purpose) ──
  await check("http_request works with NO browser", async () => {
    const t = await c("http_request", { url: `${fx.url}/api.json` });
    return [t.includes("status: 200") && t.includes("hello-api"), t.split("\n")[1]];
  });
  await check("http_request sends a Firefox UA", async () => {
    const t = await c("http_request", { url: `${fx.url}/echo` });
    return [/firefox/i.test(t), (t.match(/"user-agent":"[^"]{0,40}/) || [""])[0]];
  });
  await check("http_request POST + custom headers", async () => {
    const t = await c("http_request", { url: `${fx.url}/echo`, method: "POST", body: "x=1", headers_json: '{"X-Test":"abc"}' });
    return [t.includes('"method":"POST"') && t.includes('"x-test":"abc"'), "echoed"];
  });
  await check("http_request rejects bad headers_json", async () => {
    const t = await c("http_request", { url: `${fx.url}/api.json`, headers_json: "{nope" });
    return [t.startsWith("IS_ERROR") && t.includes("Invalid headers_json"), t.slice(0, 50)];
  });
  await check("http_request flags an anti-bot response", async () => {
    const t = await c("http_request", { url: `${fx.url}/maybe` });
    return [t.includes("looks anti-bot blocked"), t.split("\n")[1]];
  });
  await check("scrape_markdown (browserless)", async () => {
    const t = await c("scrape_markdown", { url: fx.url });
    return [t.includes("source: http") && t.includes("# Fixture Heading") && t.includes("## Second Section")
      && t.includes("- first item") && t.includes(`](${fx.url}/target)`) && !t.includes("FooterNoise"),
      "headings+list+abs-links kept, nav/footer stripped"];
  });
  await check("smart_fetch stays browserless when unblocked", async () => {
    const t = await c("smart_fetch", { url: fx.url });
    return [t.includes("path: http (no browser used)"), t.split("\n")[0]];
  });

  await check("browser_launch", async () => {
    const t = await c("browser_launch", { url: fx.url, headless: true, fresh_profile: true });
    return [t.includes("Browser launched"), t.split("\n")[0]];
  });
  await check("http_request reuses browser cookies", async () => {
    await c("cookie_set", { name: "sid", value: "abc123", domain: "127.0.0.1", expires_days: 1 });
    const t = await c("http_request", { url: `${fx.url}/echo` });
    return [t.includes("sid=abc123"), "cookie forwarded"];
  });
  await check("use_browser_cookies=false omits them", async () => {
    const t = await c("http_request", { url: `${fx.url}/echo`, use_browser_cookies: false });
    return [!t.includes("sid=abc123"), "omitted"];
  });
  await check("http_session_cookies", async () => {
    const t = await c("http_session_cookies", { url: fx.url });
    return [t.includes("sid=") && t.includes("domain="), t.split("\n")[0]];
  });
  await check("smart_fetch ESCALATES when blocked", async () => {
    maybeHits = 0;
    const t = await c("smart_fetch", { url: `${fx.url}/maybe` });
    return [t.includes("path: browser (escalated") && t.includes("Escalated OK"), t.split("\n")[0]];
  });

  await check("search normalises a SearXNG JSON response", async () => {
    const t = await c("search", { query: "hello", endpoint: fx.url, count: 5 });
    return [t.includes("2 result(s)") && t.includes("First hit") && t.includes("https://example.com/a")
      && t.includes("[brave]") && !t.includes("/not-absolute"), t.split("\n")[0]];
  });
  await check("search respects count", async () => {
    const t = await c("search", { query: "hello", endpoint: fx.url, count: 1 });
    return [t.includes("1 result(s)") && !t.includes("Second hit"), t.split("\n")[0]];
  });
  await check("search explains an HTML-only endpoint", async () => {
    const t = await c("search", { query: "hello", endpoint: `${fx.url}/search?format=html`, provider: "searxng" });
    return [t.startsWith("IS_ERROR") && t.includes("formats:") && t.includes("json"), "tells you the settings.yml fix"];
  });
  await check("search needs an endpoint", async () => {
    const t = await c("search", { query: "hello" });
    return [t.startsWith("IS_ERROR") && t.includes("MCP_SEARCH_ENDPOINT"), t.slice(0, 60)];
  });
  await check("search refuses a keyless paid provider", async () => {
    const t = await c("search", { query: "hello", endpoint: "https://api.tavily.com" });
    return [t.startsWith("IS_ERROR") && t.includes("needs an API key"), t.slice(0, 60)];
  });
  await check("search rejects bad extra_params", async () => {
    const t = await c("search", { query: "hello", endpoint: fx.url, extra_params: "{nope" });
    return [t.startsWith("IS_ERROR") && t.includes("Invalid extra_params"), t.slice(0, 50)];
  });

  // ── ergonomics ──
  await c("navigate", { url: fx.url });
  await check("search_page finds text with context", async () => {
    const t = await c("search_page", { text: "XYZZY-42" });
    return [t.includes("1 match") && t.includes("magic token"), t.split("\n")[1]];
  });
  await check("search_page rejects a bad regex", async () => {
    const t = await c("search_page", { text: "([unclosed", regex: true });
    return [t.startsWith("IS_ERROR") && t.includes("Invalid pattern"), t.slice(0, 50)];
  });
  await check("assert_clickable names the blocker", async () => {
    const ok = await c("assert_clickable", { selector: "#sub" });
    const bad = await c("assert_clickable", { selector: "#under" });
    return [ok.startsWith("PASS") && bad.startsWith("FAIL") && bad.includes("blanket"), bad.split("\n")[0]];
  });
  await check("assert_clickable flags off-screen", async () => {
    const t = await c("assert_clickable", { selector: "#deep" });
    return [t.startsWith("FAIL") && t.includes("outside the viewport"), t.split("\n")[0]];
  });
  await check("scroll_to brings an element into view", async () => {
    await c("scroll_to", { selector: "#deep" });
    const t = await c("assert_clickable", { selector: "#deep" });
    return [t.startsWith("PASS"), t.split("\n")[0]];
  });
  await check("wait_for_change sees a delayed change", async () => {
    await c("evaluate", { expression: "setTimeout(function(){var d=document.createElement('div');d.textContent='LATE CONTENT ARRIVED';document.body.appendChild(d);},1200);'ok'" });
    const t = await c("wait_for_change", { timeout: 8000 });
    return [t.includes("Page changed"), t.split("\n")[1]];
  });
  await check("wait_for_change is honest when nothing happens", async () => {
    const t = await c("wait_for_change", { timeout: 1500 });
    return [t.includes("No change detected"), t.slice(0, 40)];
  });
  await check("click_element_offset lands where asked", async () => {
    await c("evaluate", { expression: "window.scrollTo(0,0);document.getElementById('pos').textContent='none';'ok'" });
    await c("click_element_offset", { selector: "#wide", x_percent: 10, y_percent: 50 });
    const pos = await c("evaluate", { expression: "document.getElementById('pos').textContent" });
    const [x, y] = pos.split(",").map(Number);
    return [Math.abs(x - 10) <= 6 && Math.abs(y - 50) <= 12, `${pos}%`];
  });
  await check("click_at_corner lands in the corner", async () => {
    await c("evaluate", { expression: "document.getElementById('pos').textContent='none';'ok'" });
    await c("click_at_corner", { selector: "#wide", corner: "top-right", offset: 8 });
    const pos = await c("evaluate", { expression: "document.getElementById('pos').textContent" });
    const [x, y] = pos.split(",").map(Number);
    return [x > 90 && y < 25, `${pos}%`];
  });
  await check("paste_text delivers a REAL paste event", async () => {
    const t = await c("paste_text", { selector: "#po", text: "pasted-value-1" });
    const model = await c("evaluate", { expression: "document.getElementById('pomodel').textContent" });
    return [model === "pasted-value-1" && t.includes("real clipboard"), `model=${model}`];
  });
  await check("form_introspect reports constraints", async () => {
    const j = JSON.parse(await c("form_introspect", {}));
    const pw = j.fields.find(f => f.name === "password");
    return [j.form_found && j.fields.length === 3 && pw.minlength === "8", `fields=${j.fields.length}`];
  });
  await check("smart_fill fills by label", async () => {
    const t = await c("smart_fill", { fields_json: JSON.stringify({ "Email Address": "smart@x.com", Password: "hunter2secret", Nickname: "robi" }) });
    const v = await c("evaluate", { expression: "[document.getElementById('email').value,document.getElementById('pw').value,document.getElementById('nick').value].join('|')" });
    return [t.includes("3/3 filled") && v === "smart@x.com|hunter2secret|robi", v];
  });
  await check("smart_fill + submit_label", async () => {
    await c("smart_fill", { fields_json: JSON.stringify({ Nickname: "zz" }), submit_label: "Send Form" });
    const out = await c("evaluate", { expression: "document.getElementById('subout').textContent" });
    return [out === "submitted", out];
  });
  await check("wait_for_request catches the call", async () => {
    await c("evaluate", { expression: "setTimeout(function(){fetch('/api.json');},700);'ok'" });
    const t = await c("wait_for_request", { url_pattern: "/api.json", timeout: 8000 });
    return [t.includes("GET") && t.includes("/api.json"), t.split("\n")[0]];
  });
  // v0.9.6 regression: idle returned immediately while a request was in flight
  await check("wait_for_network_idle sees in-flight requests", async () => {
    slowDone = false;
    await c("evaluate", { expression: "fetch('/slow');'ok'" });
    await new Promise(r => setTimeout(r, 400));
    const t0 = Date.now();
    await c("wait_for_network_idle", { idle_ms: 300, timeout_ms: 9000 });
    const el = Date.now() - t0;
    return [el > 1500 && slowDone, `waited ${el}ms`];
  });
  // v0.9.6 regression: click_and_wait reported success on an unmet condition
  await check("click_and_wait reports an unmet wait", async () => {
    const s = await c("browser_snapshot");
    const t = await c("click_and_wait", { ref: refOf(s, '"Send Form"'), wait_for_url: "/never-happens", timeout_ms: 800 });
    return [t.startsWith("IS_ERROR") && t.includes("did NOT succeed"), t.slice(0, 70)];
  });
  // v0.9.6 regression: a second recorder leaked the first listener
  await check("mouse_record does not leak its listener", async () => {
    await c("mouse_record", { duration_ms: 250 });
    await c("mouse_record", { duration_ms: 500 });
    await new Promise(r => setTimeout(r, 800));
    await c("mouse_move", { x: 200, y: 200 }); await c("mouse_move", { x: 260, y: 240 });
    const pts = await c("evaluate", { expression: "String((window.__mcp_mouse_rec&&window.__mcp_mouse_rec.points.length)||0)" });
    return [Number(pts) === 0, `points=${pts}`];
  });
  await check("storage_snapshot + storage_diff", async () => {
    await c("storage_snapshot", { name: "before" });
    await c("localstorage_set", { key: "token", value: "tok-999" });
    const t = await c("storage_diff", { name: "before" });
    return [t.includes("token") && t.includes("tok-999"), t.split("\n")[0]];
  });
  await check("indexeddb list + delete", async () => {
    await c("evaluate", { expression: "new Promise(function(res){var r=indexedDB.open('kitdb',1);r.onsuccess=function(){r.result.close();res('ok')};r.onerror=function(){res('err')}})" });
    const l = await c("indexeddb_list");
    const d = await c("indexeddb_delete", { name: "kitdb" });
    return [l.includes("kitdb") && d.includes("deleted"), d];
  });
  await check("performance_timeline", async () => {
    const j = JSON.parse(await c("performance_timeline"));
    return [typeof j.load_ms === "number" && j.cumulative_layout_shift === "unsupported-in-firefox", `load=${j.load_ms}ms`];
  });
  await check("workflow_run executes a sequence", async () => {
    const t = await c("workflow_run", { steps: [
      { tool: "navigate", args: { url: `${fx.url}/target` } },
      { tool: "assert_text_present", args: { text: "Target Page" } },
      { tool: "search_page", args: { text: "Target" } },
    ] });
    return [t.includes("3 step(s) executed, 0 failed"), t.split("\n")[0]];
  });
  await check("workflow_run stops with a resume hint", async () => {
    const t = await c("workflow_run", { steps: [{ tool: "get_url", args: {} }, { tool: "nope_tool", args: {} }] });
    return [t.startsWith("IS_ERROR") && t.includes("UNKNOWN TOOL") && t.includes("start_at=1"), "resume hint present"];
  });
  await check("browser_recover resets a live session", async () => {
    const t = await c("browser_recover");
    const st = await c("server_status");
    return [t.includes("server state reset") && st.includes('"browser_up": false'), "recovered"];
  });

  S.kill(); fx.close();
  return report();
}
