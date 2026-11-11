// What a page can see of this server, and what the server says about a click.
//
// Every check here answers a measured defect. The fixture wraps the DOM functions a
// detector would wrap and counts calls that did not come from its own scripts, so "the
// page cannot see it" is read from the page, not assumed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { startServer, fixtureServer, refOf, runner, until, camoufoxCache, ROOT, DIST } from "./harness.mjs";

const LAUNCH = { headless: true, fresh_profile: true, geoip: false };

// Runs in the page's own world, before anything else.
const HOOKS = `<script>
window.__foot = { calls: 0, names: {}, muts: 0 };
window.__m = { pressed: 0, covered: 0, alerted: 0, disabled: 0, hovered: 0, trapped: 0, remembered: 0, shadow: 0, nested: 0, secretNumber: 42 };
(function () {
  var own = location.origin;
  function note(name) {
    var lines = String(new Error().stack || "").split("\\n").filter(Boolean).slice(2);
    if (lines.some(function (l) { return l.indexOf(own) !== -1; })) return;
    __foot.calls++; __foot.names[name] = (__foot.names[name] || 0) + 1;
  }
  function wrap(proto, name) { var orig = proto[name]; if (!orig) return; proto[name] = function () { note(name); return orig.apply(this, arguments); }; }
  [[Document.prototype, "querySelector"], [Document.prototype, "querySelectorAll"], [Document.prototype, "elementFromPoint"],
   [Document.prototype, "getElementById"], [Element.prototype, "getBoundingClientRect"], [Element.prototype, "getAttribute"],
   [Element.prototype, "setAttribute"], [Element.prototype, "matches"], [Node.prototype, "contains"], [window, "getComputedStyle"],
   [ShadowRoot.prototype, "querySelector"], [ShadowRoot.prototype, "querySelectorAll"], [ShadowRoot.prototype, "getElementById"],
   [ShadowRoot.prototype, "elementFromPoint"], [Node.prototype, "getRootNode"]]
    .forEach(function (p) { wrap(p[0], p[1]); });
  // Reading into a shadow root starts at this getter.
  var sd = Object.getOwnPropertyDescriptor(Element.prototype, "shadowRoot");
  Object.defineProperty(Element.prototype, "shadowRoot", { configurable: true, enumerable: sd.enumerable, get: function () { note("shadowRoot"); return sd.get.call(this); } });
  // Mutations inside a shadow root never reach an observer on the document.
  window.__watchShadow = function (root) {
    new MutationObserver(function (ms) { __foot.muts += ms.length; })
      .observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  };
  addEventListener("DOMContentLoaded", function () {
    new MutationObserver(function (ms) { __foot.muts += ms.length; })
      .observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  });
})();
</script>`;

const page = frameOrigin => `<!doctype html><html><head><title>Footprint</title>${HOOKS}
<style>.row{margin:26px 0;position:relative} #overlay{position:absolute;left:-6px;top:-6px;width:190px;height:34px;z-index:5;background:rgba(200,0,0,.1)} .hid{position:absolute;opacity:0;width:0;height:0}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}</style></head><body>
<h1>Footprint</h1>
<div class="row"><button id="quiet" onclick="__m.pressed++">Quiet button</button></div>
<div class="row"><button id="covered" onclick="__m.covered++">Covered button</button><div id="overlay"></div></div>
<div class="row"><button id="alerter" onclick="alert('from fixture'); __m.alerted++">Alert button</button></div>
<div class="row"><button id="off" disabled onclick="__m.disabled++">Disabled button</button></div>
<div class="row"><label for="mail">Email address</label> <input id="mail" type="email"></div>
<div class="row"><label>Country <select id="country"><option value="id">Indonesia</option><option value="jp">Japan</option></select></label></div>
<div class="row"><span id="bn">Billing name</span> <input id="bill" aria-labelledby="bn"></div>
<div class="row"><input id="tog" type="checkbox" class="hid"><label for="tog">Styled toggle</label></div>
<div class="row"><iframe id="xf" title="Other origin" src="${frameOrigin}/frame" width="420" height="90"></iframe></div>
<div class="row"><iframe id="tk" title="Ticker" src="${frameOrigin}/ticker" width="200" height="60"></iframe></div>
<div class="row"><button id="hov" onmouseenter="__m.hovered++">Hover target</button>
 <button id="conf" onclick="if (confirm('leave?')) setTimeout(function () { location.href = '/static?confirmed'; }, 150)">Confirm and leave</button></div>
<div class="row"><label for="cexp">Expiry month</label> <select id="cexp" name="card_exp_month"><option>Month-01</option><option selected>Month-07</option></select></div>
<div class="row"><input id="rem" type="checkbox" class="sr" onchange="__m.remembered++"><label for="rem">Remember me</label></div>
<div class="row"><x-card id="card"></x-card> <x-sealed></x-sealed></div>
<a id="trap" href="#trapped" onclick="__m.trapped++" style="position:absolute;left:-9999px;top:40px;width:120px">Trap link</a>
<p><span id="sc-l">Main document decoy</span></p>
<script>
customElements.define("x-inner", class extends HTMLElement {
  constructor() { super(); var r = this.attachShadow({ mode: "open" });
    r.innerHTML = '<span id="np">nested idle</span> <button id="nb">Nested shadow button</button>';
    r.getElementById("nb").addEventListener("click", function () { __m.nested++; r.getElementById("np").textContent = "nested clicked"; });
    __watchShadow(r); }
});
customElements.define("x-card", class extends HTMLElement {
  constructor() { super(); var r = this.attachShadow({ mode: "open" });
    r.innerHTML = '<button id="sb">Shadow button</button> <label for="sn">Shadow name</label> <input id="sn">'
      + ' <span id="sc-l">Shadow city</span> <input id="sc" aria-labelledby="sc-l"> <x-inner></x-inner>';
    r.getElementById("sb").addEventListener("click", function () { __m.shadow++; });
    __watchShadow(r); }
});
customElements.define("x-sealed", class extends HTMLElement {
  constructor() { super(); var r = this.attachShadow({ mode: "closed" }); r.innerHTML = '<button>Sealed button</button>'; }
});
</script>
</body></html>`;

// An iframe that changes its own text every 100ms, like a playing video or a rotating ad.
const TICKER = `<!doctype html><html><body><h2 id="t">tick 0</h2>
<script>var n = 0; setInterval(function () { document.getElementById("t").textContent = "tick " + (++n); }, 100);</script></body></html>`;

// Frames a user can and cannot see, each with a button named after it.
const FRAMES = o => `<!doctype html><html><head><title>Frames</title></head><body>
<iframe src="${o}/frame?b=Shown" width="300" height="80"></iframe>
<iframe src="${o}/frame?b=Invisible" width="300" height="80" style="visibility:hidden"></iframe>
<div style="opacity:0"><iframe src="${o}/frame?b=Transparent" width="300" height="80"></iframe></div>
<iframe src="${o}/frame?b=Offscreen" width="300" height="80" style="position:absolute;left:0;top:-10000px"></iframe>
<iframe id="later" src="${o}/frame?b=Later" width="300" height="80"></iframe>
</body></html>`;

// More open shadow roots than a snapshot reads, and one chain nested deeper than it follows.
const COMPONENTS = `<!doctype html><html><head><title>Components</title></head><body><x-deep level="0"></x-deep><div id="many"></div><script>
customElements.define("x-deep", class extends HTMLElement { constructor() { super(); var l = +this.getAttribute("level");
  this.attachShadow({ mode: "open" }).innerHTML = "<button>Depth " + l + "</button>" + (l < 11 ? '<x-deep level="' + (l + 1) + '"></x-deep>' : ""); } });
customElements.define("x-item", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<button>Item " + this.getAttribute("i") + "</button>"; } });
var h = ""; for (var i = 0; i < 1100; i++) h += '<x-item i="' + i + '"></x-item>'; document.getElementById("many").innerHTML = h;
</script></body></html>`;

// A classic form whose server answers after 2.5s, like a slow login or checkout.
const SLOW_FORM = `<!doctype html><html><head><title>Slow form</title></head><body>
<form method="post" action="/submit"><input name="q" value="x"><button>Send slowly</button></form></body></html>`;

const FRAME = (b = "Frame") => `<!doctype html><html><head><title>Frame</title></head><body>
<button id="fb" onclick="window.__clicked=(window.__clicked||0)+1; document.getElementById('fs').textContent='frame clicked'">${b} button</button>
<label for="fi">${b} input</label> <input id="fi"><p id="fs">frame idle</p></body></html>`;

export default async function run() {
  const { check, report } = runner("suite-footprint");
  let fx = null, fx2 = null, S = null;
  try {
    // Frames come from a second server: another port is another origin, with no
    // dependence on how this machine resolves "localhost" (the fixture listens on
    // 127.0.0.1 only, and localhost may resolve to ::1).
    const frameRoutes = {
      "/frame": (q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(FRAME(new URL(q.url, "http://x").searchParams.get("b") || undefined)); },
      "/ticker": (_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(TICKER); },
    };
    fx2 = await fixtureServer(frameRoutes);
    let posts = 0;
    fx = await fixtureServer({
      ...frameRoutes,
      "/": (_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(page(fx2.url)); },
      "/frames": (_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(FRAMES(fx2.url)); },
      "/reloader": (q, r) => { const i = Number(new URL(q.url, "http://x").searchParams.get("i")) || 0; r.writeHead(200, { "content-type": "text/html" }); r.end(`<!doctype html><button>Reloading ${i}</button><script>setTimeout(function () { location.reload(); }, ${6 + 3 * i})</script>`); },
      "/reloading": (_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<!doctype html><title>Reloading</title><button>main</button>" + Array.from({ length: 8 }, (_, i) => `<iframe src="/reloader?i=${i}" width="120" height="40"></iframe>`).join("")); },
      "/form": (_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(SLOW_FORM); },
      "/submit": (q, r) => { if (q.method === "POST") posts++; q.resume(); setTimeout(() => { r.writeHead(200, { "content-type": "text/html" }); r.end("<!doctype html><title>Submitted</title><p>done</p>"); }, 2500); },
      "/other": (_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<!doctype html><title>Other</title><script>setInterval(function () { alert('from the other tab'); }, 150)</script>"); },
      "/static": (_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<!doctype html><title>Static</title><p>static</p>"); },
      "/components": (_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(COMPONENTS); },
      "/init": (_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<!doctype html><title>x</title><script>document.title = 'init=' + String(window.__fromInit)</script>"); },
      "/late": (_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<!doctype html><title>Late</title><p id='o'>waiting</p><script>fetch('/slow').then(function(x){return x.text()}).then(function(t){document.getElementById('o').textContent=t})</script>"); },
      "/slow": (_q, r) => setTimeout(() => { r.writeHead(200, { "content-type": "text/plain" }); r.end("arrived"); }, 400),
    });
    S = await startServer();
    const c = S.call;
    const timed = async (name, args) => { const t = Date.now(); const text = await c(name, args); return { text, ms: Date.now() - t }; };
    // Read in the isolated world, so the reading itself is not counted.
    const iso = expression => c("evaluate", { world: "isolated", expression });
    const foot = async () => JSON.parse(await iso("JSON.stringify(window.wrappedJSObject.__foot)"));
    const marks = async () => JSON.parse(await iso("JSON.stringify(window.wrappedJSObject.__m)"));
    const home = () => c("navigate", { url: fx.url + "/" });
    // A check takes its own snapshot, so it means the same thing run alone.
    const fresh = async () => { await home(); return c("browser_snapshot"); };

    const launchText = await c("browser_launch", { ...LAUNCH, url: fx.url + "/" });
    const hostOs = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

    // ── What the page can see ────────────────────────────────────────────────
    // Refs were data-mcp-ref attributes: 16 mutations per snapshot on a small page.
    await check("a snapshot writes nothing into the document", async () => {
      await c("browser_snapshot"); await c("browser_snapshot");
      const f = await foot();
      // Inside the open shadow roots too, which document.querySelectorAll does not reach.
      const attrs = Number(await iso(`(function () { var n = 0; (function walk(root) { n += root.querySelectorAll("[data-mcp-ref]").length;
        root.querySelectorAll("*").forEach(function (e) { if (e.shadowRoot) walk(e.shadowRoot); }); })(document); return n; })()`));
      const listed = /Shadow button/.test(await c("browser_snapshot"));
      return [f.calls === 0 && f.muts === 0 && attrs === 0 && listed, `calls=${f.calls} muts=${f.muts} refAttrs=${attrs} shadowListed=${listed} ${JSON.stringify(f.names)}`];
    });
    await check("click, fill and hover call nothing the page can wrap", async () => {
      await home();
      const snap = await c("browser_snapshot");
      await c("click", { ref: refOf(snap, "Quiet button") });
      await c("fill", { ref: refOf(snap, 'label="Email address"'), value: "a@b.co" });
      // A hover that lands, read from the page: the covered button used to be the target,
      // so this checked a hover that failed after five seconds.
      const hover = await c("hover", { ref: refOf(snap, "Hover target") });
      const f = await foot(), m = await marks();
      const value = await iso("document.getElementById('mail').value");
      return [f.calls === 0 && f.muts === 0 && m.pressed === 1 && value === "a@b.co" && m.hovered >= 1 && !hover.startsWith("IS_ERROR"),
        `calls=${f.calls} muts=${f.muts} pressed=${m.pressed} hovered=${m.hovered} value=${value} ${JSON.stringify(f.names)}`];
    });
    await check("an isolated evaluate is invisible, a main-world one is not", async () => {
      await home();
      await iso("document.querySelector('#quiet').id");
      const quiet = (await foot()).calls;
      await c("evaluate", { expression: "document.querySelector('#quiet').id" });
      const loud = (await foot()).calls;
      return [quiet === 0 && loud >= 1, `isolated=${quiet} main=${loud}`];
    });

    // ── evaluate reaches the page again ──────────────────────────────────────
    // Camoufox moved page.evaluate into an isolated world; window.anything read as
    // undefined and 25 tools' own checks failed on a fresh install.
    await check("evaluate reads the page's own variables by default", async () => {
      const main = await c("evaluate", { expression: "window.__m.secretNumber" });
      const isolated = await iso("typeof window.__m");
      return [main === "42" && isolated === "undefined", `main=${main} isolated=${isolated}`];
    });
    await check("inject_init_script defines what page scripts see", async () => {
      await c("inject_init_script", { script: "window.__fromInit = 7;" });
      await c("navigate", { url: fx.url + "/init" });
      const title = await iso("document.title");
      return [title === "init=7", title];
    });

    // ── Snapshot content ─────────────────────────────────────────────────────
    let snap = "";
    await check("a field is named by its label and the label row goes", async () => {
      await home();
      snap = await c("browser_snapshot");
      const line = needle => snap.split("\n").find(l => l.includes(needle)) || "";
      const mail = line('label="Email address"'), country = line('label="Country"'), bill = line('label="Billing name"');
      const ok = mail.includes("[input]") && country.includes("[select]") && country.includes('"Indonesia"') && !country.includes("Japan")
        && bill.includes("[input]") && !snap.includes('[label] "Email address"') && !/\[label\][^\n]*Country/.test(snap);
      return [ok, `${mail.trim()} | ${country.trim()} | ${bill.trim()}`];
    });
    await check("a label standing in for a hidden checkbox keeps its row", async () => {
      snap = await fresh();
      return [/\[label\] "Styled toggle"/.test(snap), (snap.split("\n").find(l => l.includes("Styled toggle")) || "MISSING").trim()];
    });
    await check("elements inside a cross-origin iframe get refs", async () => {
      snap = await fresh();
      const frameBtn = refOf(snap, "Frame button"), frameInput = refOf(snap, 'label="Frame input"');
      return [/^f\d+e\d+$/.test(frameBtn || "") && /^f\d+e\d+$/.test(frameInput || "") && snap.includes("In frame f1"), `button=${frameBtn} input=${frameInput}`];
    });
    await check("a click inside the iframe lands and is reported as a change", async () => {
      snap = await fresh();
      const r = await c("click", { ref: refOf(snap, "Frame button") });
      const state = await c("frame_evaluate", { frame_index: 1, expression: "String(window.__clicked) + '/' + document.getElementById('fs').textContent" });
      await c("fill", { ref: refOf(snap, 'label="Frame input"'), value: "in frame" });
      const value = await c("frame_evaluate", { frame_index: 1, world: "isolated", expression: "document.getElementById('fi').value" });
      return [state === "1/frame clicked" && r.includes("Page content changed") && value === "in frame", `${state} value=${value} | ${r.slice(0, 90)}`];
    });
    // A snapshot stopped at the host of a web component, so nothing inside it had a ref.
    await check("elements inside open shadow roots get refs, labelled from their own root", async () => {
      snap = await fresh();
      const line = needle => (snap.split("\n").find(l => l.includes(needle)) || "").trim();
      const name = line('label="Shadow name"'), city = line('label="Shadow city"');
      // In place of their host, before what follows it in the document.
      const order = ["Shadow button", 'label="Shadow name"', 'label="Shadow city"', "Nested shadow button", "Trap link"].map(n => snap.indexOf(n));
      const ok = /^ref=e\d+ +\[button\] "Shadow button"/.test(line("Shadow button")) && name.includes("[input]") && city.includes("[input]")
        && /\[button\] "Nested shadow button"/.test(snap) && !snap.includes("Sealed button") && !snap.includes('label="Main document decoy"')
        && !snap.includes('[label] "Shadow name"') && order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1]));
      return [ok, `${line("Shadow button")} | ${name} | ${city} | sealed=${snap.includes("Sealed button")} order=${order.join(",")}`];
    });
    await check("a click and a fill inside a shadow root land, and a change there is reported", async () => {
      snap = await fresh();
      const card = "document.getElementById('card').shadowRoot";
      const pressed = await c("click", { ref: refOf(snap, "Shadow button") });
      const nested = await c("click", { ref: refOf(snap, "Nested shadow button") });
      const filled = await c("fill", { ref: refOf(snap, 'label="Shadow name"'), value: "Budi" });
      const free = await c("assert_clickable", { ref: refOf(snap, "Shadow button") });
      const m = await marks();
      const value = await iso(`${card}.getElementById('sn').value`);
      const text = await iso(`${card}.querySelector('x-inner').shadowRoot.getElementById('np').textContent`);
      const ok = m.shadow === 1 && m.nested === 1 && value === "Budi" && text === "nested clicked" && /Page content changed/.test(nested)
        && ![pressed, nested, filled].some(t => t.startsWith("IS_ERROR") || t.includes("⚠ the real")) && free.startsWith("PASS");
      return [ok, `shadow=${m.shadow} nested=${m.nested} value=${value} text=${text} | ${nested.split("\n")[1] || nested} | ${free.split("\n")[0]}`];
    });
    await check("browser_snapshot(frames=false) leaves iframes out", async () => {
      const t = await c("browser_snapshot", { frames: false });
      return [!t.includes("Frame button") && t.includes("Quiet button"), t.includes("Frame button") ? "frame listed" : "main only"];
    });

    await check("a snapshot stops at the shadow-root limits and says so", async () => {
      await c("navigate", { url: fx.url + "/components" });
      const t = await c("browser_snapshot");
      const many = /(\d+) more shadow root\(s\) were not read \(limit (\d+) per document\)/.exec(t);
      const deep = /(\d+) shadow root\(s\) nested deeper than (\d+) levels were not read/.exec(t);
      // 1,112 roots in all: 12 nested (8 read), 1,100 items (the rest of the limit).
      const read = many ? 1112 - 4 - Number(many[1]) : 0;
      return [!!many && !!deep && read === Number(many[2]) && t.includes('"Depth 7"') && !t.includes('"Depth 8"') && deep[1] === "1",
        `${many ? many[0] : "no limit note"} | ${deep ? deep[0] : "no depth note"} | read=${read}`];
    });

    // ── What a click says, and how long it takes to say it ───────────────────
    await check("a disabled element is refused without waiting out the click timeout", async () => {
      await home(); snap = await c("browser_snapshot");
      const r = await timed("click", { ref: refOf(snap, "Disabled button") });
      const m = await marks();
      return [r.text.startsWith("IS_ERROR") && /disabled/.test(r.text) && m.disabled === 0 && r.ms < 1400, `${r.ms}ms ${r.text.slice(0, 80)}`];
    });
    await check("a ref that names nothing fails at once", async () => {
      const r = await timed("click", { ref: "e9999" });
      const f = await timed("fill", { ref: "e9999", value: "x" });
      const ok = x => x.text.startsWith("IS_ERROR") && /not found/i.test(x.text) && x.ms < 1000;
      return [ok(r) && ok(f), `click ${r.ms}ms, fill ${f.ms}ms: ${f.text.slice(0, 70)}`];
    });
    // The fallback built its events with `view: window`, which the isolated world's
    // global is not, so every covered click threw after five seconds.
    await check("a covered element is clicked through the fallback, which names the blocker", async () => {
      const r = await timed("click", { ref: refOf(await fresh(), "Covered button") });
      const m = await marks();
      return [m.covered === 1 && r.text.includes("⚠") && /overlay/.test(r.text) && r.ms < 4000, `${r.ms}ms covered=${m.covered} ${r.text.replace(/\s+/g, " ").slice(0, 110)}`];
    });
    await check("a click that opens a dialog is reported as the dialog", async () => {
      const r = await timed("click", { ref: refOf(await fresh(), "Alert button") });
      const m = await marks();
      return [/opened an alert dialog/.test(r.text) && !/No page change/.test(r.text) && !r.text.startsWith("IS_ERROR") && m.alerted === 1 && r.ms < 1000, `${r.ms}ms ${r.text.replace(/\s+/g, " ").slice(0, 120)}`];
    });

    // A form whose server takes 2.5s. Playwright counts the wait for the navigation to
    // commit inside the click timeout, so the 1.5s quick click timed out AFTER the click
    // was sent, and the retry sent the form a second time.
    await check("a click on a slow form is sent once and reported as a navigation", async () => {
      await c("navigate", { url: fx.url + "/form" });
      const before = posts;
      const r = await c("click", { ref: refOf(await c("browser_snapshot"), "Send slowly") });
      const title = await until(async () => { const t = await iso("document.title"); return t === "Submitted" && t; }, 6000);
      await new Promise(res => setTimeout(res, 300));
      const sent = posts - before;
      return [sent === 1 && !r.startsWith("IS_ERROR") && !/not found/i.test(r) && /navigat/i.test(r) && title === "Submitted",
        `posts=${sent} title=${title} ${r.replace(/\s+/g, " ").slice(0, 110)}`];
    });
    await check("a double click lands and a blocked right click is refused", async () => {
      snap = await fresh();
      const before = await marks();
      const dbl = await c("click", { ref: refOf(snap, "Quiet button"), dblclick: true });
      const right = await c("click", { ref: refOf(snap, "Covered button"), button: "right" });
      const m = await marks();
      return [!dbl.startsWith("IS_ERROR") && m.pressed - before.pressed === 2 && right.startsWith("IS_ERROR") && /Nothing was fired/.test(right) && m.covered === before.covered,
        `dbl pressed +${m.pressed - before.pressed} | right: ${right.replace(/\s+/g, " ").slice(0, 90)}`];
    });
    // Every frame the snapshot gave refs to was hashed: an iframe changing its own text
    // made a click that did nothing read "Page content changed".
    await check("a live iframe does not make a dead click read as a change", async () => {
      snap = await fresh();
      const tick1 = await c("frame_evaluate", { frame_index: 2, world: "isolated", expression: "document.getElementById('t').textContent" });
      const r = await c("click", { ref: refOf(snap, "Quiet button") });
      const tick2 = await c("frame_evaluate", { frame_index: 2, world: "isolated", expression: "document.getElementById('t').textContent" });
      return [/No page change observed/.test(r) && tick1 !== tick2 && snap.includes('"tick'), `${tick1} -> ${tick2} | ${r.replace(/\s+/g, " ").slice(0, 100)}`];
    });
    // A snapshot read every iframe at least 20x20, hidden or not; the fallback then fired
    // handlers inside a frame no user could see.
    await check("an iframe the user cannot see is left out of the snapshot", async () => {
      await c("navigate", { url: fx.url + "/frames" });
      const t = await c("browser_snapshot");
      const listed = ["Shown", "Invisible", "Transparent", "Offscreen", "Later"].filter(b => t.includes(`"${b} button"`));
      return [listed.join(",") === "Shown,Later", `listed: ${listed.join(",")}`];
    });
    await check("a ref inside an iframe hidden since the snapshot is refused", async () => {
      await c("navigate", { url: fx.url + "/frames" });
      const t = await c("browser_snapshot");
      await iso("document.getElementById('later').style.visibility = 'hidden'");
      const r = await c("click", { ref: refOf(t, "Later button") });
      const idx = await iso("String([].indexOf.call(window.frames, document.getElementById('later').contentWindow) + 1)");
      const fired = await c("frame_evaluate", { frame_index: Number(idx), world: "isolated", expression: "String(window.wrappedJSObject.__clicked)" });
      return [r.startsWith("IS_ERROR") && /Nothing was fired/.test(r) && fired === "undefined", `fired=${fired} ${r.replace(/\s+/g, " ").slice(0, 110)}`];
    });
    // A frame that navigated while it was read ("Execution context was destroyed") was
    // left out of the snapshot without a word. Frames that keep reloading hit that now and
    // then; how often varies run to run, so this guards the note rather than finding it.
    await check("a snapshot that could not read an iframe says so", async () => {
      await c("navigate", { url: fx.url + "/reloading" });
      let short = 0, unexplained = 0;
      for (let i = 0; i < 40; i++) {
        const t = await c("browser_snapshot");
        const listed = new Set(t.match(/Reloading \d/g) || []).size;
        const noted = Number((t.match(/(\d+) iframe\(s\) could not be read/) || [0, 0])[1]);
        if (listed < 8) { short++; if (listed + noted < 8) unexplained++; }
      }
      return [unexplained === 0, `snapshots missing a frame: ${short}/40, unexplained: ${unexplained}`];
    });
    // Nothing covers it, it just cannot be reached (a honeypot at left:-9999px). The
    // synthetic fallback used to click it anyway.
    await check("an element no user can reach is refused, not clicked synthetically", async () => {
      snap = await fresh();
      const r = await c("click", { ref: refOf(snap, "Trap link") });
      const m = await marks();
      return [r.startsWith("IS_ERROR") && /Nothing was fired/.test(r) && /viewport/.test(r) && m.trapped === 0 && !r.includes("⚠ the real mouse click"),
        `trapped=${m.trapped} ${r.replace(/\s+/g, " ").slice(0, 120)}`];
    });
    // within="ref:…" was looked up in the main document's registry only, and a scope that
    // named nothing silently became the whole page.
    await check("smart_fill with a scope that names nothing fails instead of searching the page", async () => {
      snap = await fresh();
      const stale = await c("smart_fill", { fields_json: JSON.stringify({ "Email address": "wrong@x.co" }), within: "ref:e9999" });
      const inFrame = await c("smart_fill", { fields_json: JSON.stringify({ "Email address": "wrong@x.co" }), within: "ref:" + refOf(snap, "Frame button") });
      const missing = await c("smart_fill", { fields_json: JSON.stringify({ "Email address": "wrong@x.co" }), within: "#no-such-dialog" });
      const value = await iso("document.getElementById('mail').value");
      return [[stale, inFrame, missing].every(t => t.startsWith("IS_ERROR")) && value === "", `value=${JSON.stringify(value)} | ${stale.slice(0, 60)} | ${inFrame.slice(0, 60)} | ${missing.slice(0, 60)}`];
    });
    await check("the chosen option of a secret-looking select is masked", async () => {
      snap = await fresh();
      const line = (snap.split("\n").find(l => l.includes('label="Expiry month"')) || "MISSING").trim();
      return [line.includes("[select]") && !line.includes("Month-07") && /masked/.test(line), line];
    });
    // An sr-only checkbox (1x1, clipped) passes the size filter, so its label lost its row
    // and nothing left in the snapshot could be clicked for real.
    await check("a label for an sr-only checkbox keeps its row and clicks for real", async () => {
      snap = await fresh();
      const label = refOf(snap, '[label] "Remember me"');
      const r = label ? await c("click", { ref: label }) : "no label row";
      const m = await marks();
      const checked = await iso("String(document.getElementById('rem').checked)");
      return [!!label && m.remembered === 1 && checked === "true" && !r.includes("⚠") && !r.startsWith("IS_ERROR"), `label=${label} checked=${checked} ${r.replace(/\s+/g, " ").slice(0, 80)}`];
    });
    // The dialog log is global: a dialog on another tab during the click was reported as
    // this click's reaction.
    await check("a dialog on another tab is not this click's reaction", async () => {
      snap = await fresh();
      await c("tab_new", { url: fx.url + "/other" });
      await c("tab_select", { index: 0 });
      const r = await c("click", { ref: refOf(snap, "Quiet button") });
      await c("tab_close", { index: 1 });
      return [/No page change observed/.test(r) && !/opened an? \w+ dialog/.test(r), r.replace(/\s+/g, " ").slice(0, 140)];
    });
    // After a dialog the click returned at once, so an accepted confirm that navigates
    // was reported as the dialog alone.
    await check("an accepted confirm that navigates reports the navigation", async () => {
      snap = await fresh();
      await c("dialog_handle", { action: "accept" });
      const r = await c("click", { ref: refOf(snap, "Confirm and leave") });
      const url = await c("get_url");
      return [/confirm dialog/.test(r) && /navigated/i.test(r) && /confirmed/.test(url), `${url} | ${r.replace(/\s+/g, " ").slice(0, 120)}`];
    });

    // ── Navigation ───────────────────────────────────────────────────────────
    // settle waited 200ms of quiet on every page, loaded or not: 259ms per navigate.
    await check("navigate does not wait out a quiet window on a loaded page", async () => {
      const times = [];
      // Each navigate must have landed: a navigate that fails at once is fast too.
      let landed = 0;
      for (let i = 0; i < 5; i++) {
        const t = Date.now();
        const text = await c("navigate", { url: `${fx.url}/static?${i}` });
        times.push(Date.now() - t);
        if (!text.startsWith("IS_ERROR") && /Title: Static/.test(text)) landed++;
      }
      // The fastest of five: a busy machine only adds time, and the old 200ms quiet window
      // put a floor under every one of them.
      const fastest = Math.min(...times);
      return [landed === 5 && fastest < 160, `landed=${landed}/5 fastest=${fastest}ms of ${times.join(",")}`];
    });
    await check("navigate still waits for a request the page started while loading", async () => {
      await c("navigate", { url: fx.url + "/late" });
      const text = await iso("document.getElementById('o').textContent");
      return [text === "arrived", text];
    });

    // ── Launch ───────────────────────────────────────────────────────────────
    // Left to Camoufox, two launches in three claimed Windows on any machine: four
    // seconds slower, 450 MB heavier, and still listing the host's speech voices.
    const geometry = [];
    await check("the fingerprint claims this machine's own OS", async () => {
      const seen = [launchText.match(/Fingerprint OS: (\w+)/)?.[1]];
      // A window most laptop screens cannot hold, so the next check means something.
      for (let i = 0; i < 3; i++) {
        await c("browser_close");
        seen.push((await c("browser_launch", { ...LAUNCH, url: fx.url + "/static", width: 1900, height: 1000 })).match(/Fingerprint OS: (\w+)/)?.[1]);
        geometry.push(JSON.parse(await iso("JSON.stringify([outerWidth, outerHeight, screen.width, screen.height])")));
      }
      const ua = await iso("navigator.userAgent");
      const uaOs = /Windows/.test(ua) ? "windows" : /Macintosh/.test(ua) ? "macos" : "linux";
      return [seen.every(o => o === hostOs) && uaOs === hostOs, `host=${hostOs} launches=${seen.join(",")} ua=${uaOs}`];
    });
    // One launch in eleven drew a screen smaller than the default 1280x800 window, and a
    // 1900x1000 request missed most screens. The fingerprint is now asked for one that fits.
    await check("the window fits the screen the fingerprint claims", async () => {
      const fits = geometry.length === 3 && geometry.every(g => g[0] === 1900 && g[0] <= g[2] && g[1] <= g[3]);
      return [fits, geometry.map(g => `window ${g[0]}x${g[1]} on ${g[2]}x${g[3]}`).join("; ")];
    });
    // dom.webnotifications.enabled=false removed the constructor from every page.
    await check("window.Notification exists", async () => {
      const t = await iso("typeof Notification");
      const audit = await c("fingerprint_audit");
      // Only the Notification lines: whether the rest of a random fingerprint is clean is
      // not this check's business.
      const flagged = /window\.Notification is missing/.test(audit);
      return [t === "function" && /Notification present/.test(audit) && !flagged, `typeof=${t} auditLine=${/Notification present/.test(audit)} flagged=${flagged}`];
    });
    if (hostOs !== "windows") {
      await check("claiming another OS is allowed, and the reply says what leaks", async () => {
        await c("browser_close");
        const t = await c("browser_launch", { ...LAUNCH, url: fx.url + "/static", os: "windows" });
        const ua = await iso("navigator.userAgent");
        const voices = Number(await iso("speechSynthesis.getVoices().length"));
        const audit = await c("fingerprint_audit");
        const flagged = /user-agent says windows, but speechSynthesis lists/.test(audit);
        // A host with no voices (most Linux servers) has nothing to leak through them.
        return [/Windows/.test(ua) && /⚠ The fingerprint claims windows/.test(t) && (flagged || !/voices\s+[1-9]/.test(audit)), `ua=${/Windows/.test(ua)} warned=${/claims windows/.test(t)} auditFlag=${flagged} voices=${voices}`];
      });
    }
    await c("browser_close");

    // A failed detection read as "the page's own world", so evaluate went to the isolated
    // one without the mw: prefix and every page variable read undefined, without a warning.
    await check("an eval-world detection that fails says it does not know", async () => {
      const mod = await import(pathToFileURL(join(ROOT, "dist", "helpers.js")).href);
      const failed = await mod.detectEvalWorld({ evaluate: async () => { throw new Error("context destroyed"); } });
      const isolated = await mod.detectEvalWorld({ evaluate: async () => "object" });
      const own = await mod.detectEvalWorld({ evaluate: async () => "undefined" });
      return [failed === null && isolated === true && own === false, `failed=${failed} isolated=${isolated} own=${own}`];
    });

    // ── A persistent profile's device ────────────────────────────────────────
    // Every launch drew a new screen, GPU and core count while the profile kept its
    // logins: ten launches of one persistent profile were ten different devices. Its own
    // server, so its own sandbox HOME: the persistent profile here is a throwaway one.
    const P = await startServer();
    try {
      const idFile = join(P.home, ".camoufox-mcp", "profile", "mcp-identity.json");
      const DEVICE = `(function () {
        var gl = document.createElement("canvas").getContext("webgl"), dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
        var k = document.createElement("canvas").getContext("2d");
        function w(f) { k.font = "72px " + f; return k.measureText("mmmmmmmmmmlli WQ@#").width; }
        var fonts = ["Arial", "Helvetica Neue", "Menlo", "Avenir", "Segoe UI", "Calibri", "Consolas", "Ubuntu", "DejaVu Sans", "Cantarell", "Futura", "Tahoma"]
          .filter(function (f) { return w('"' + f + '", monospace') !== w("monospace"); }).length;
        return JSON.stringify({ screen: [screen.width, screen.height, screen.availWidth, screen.availHeight, screen.colorDepth], dpr: devicePixelRatio,
          cores: navigator.hardwareConcurrency, webgl: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) + "/" + gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "none",
          fonts: fonts, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ua: navigator.userAgent, window: [outerWidth, outerHeight, screenX, screenY] });
      })()`;
      const device = async () => JSON.parse(await P.call("evaluate", { world: "isolated", expression: DEVICE }));
      const launch = async (args = {}) => { const t = await P.call("browser_launch", { headless: true, geoip: false, url: fx.url + "/static", ...args }); return t; };
      const idLine = t => (t.match(/^⚠? ?Identity:[^\n]*/m) || ["(no identity line)"])[0];
      const major = JSON.parse(readFileSync(join(camoufoxCache(P.home), "version.json"), "utf8")).version.split(".")[0];
      const readIdentityOk = f => { try { const j = JSON.parse(readFileSync(f, "utf8")); return j.v === 1 && Array.isArray(j.webgl); } catch { return false; } };

      await check("a persistent profile keeps its device across launches, and its logins", async () => {
        const seen = [], replies = [], audits = [];
        for (let i = 0; i < 3; i++) {
          replies.push(idLine(await launch()));
          if (i === 0) await P.call("evaluate", { expression: "document.cookie = 'login=kept; max-age=86400; path=/'" });
          seen.push({ ...(await device()), cookie: await P.call("evaluate", { expression: "document.cookie" }) });
          audits.push(/No internal contradictions/.test(await P.call("fingerprint_audit")));
          await P.call("browser_close");
        }
        const same = new Set(seen.map(d => JSON.stringify(d))).size === 1;
        const d = seen[0], mode = existsSync(idFile) ? (statSync(idFile).mode & 0o777).toString(8) : "missing";
        const fits = d.window[0] <= d.screen[0] && d.window[1] <= d.screen[1];
        // What the page sees is what the profile stored, not a draw that happened to repeat.
        const id = existsSync(idFile) ? JSON.parse(readFileSync(idFile, "utf8")) : null;
        const stored = !!id && d.webgl === id.webgl.join("/") && d.cores === id.fingerprint.navigator.hardwareConcurrency
          && d.screen[0] === id.fingerprint.screen.width && d.screen[1] === id.fingerprint.screen.height;
        const ok = same && stored && d.cookie === "login=kept" && audits.every(Boolean) && fits && /new device/.test(replies[0])
          && replies.slice(1).every(r => /kept this profile's device/.test(r)) && mode === "600"
          && d.ua.includes(`rv:${major}.0`) && d.ua.includes(`Firefox/${major}.0`) && /Macintosh|Windows|Linux/.test(d.ua) && (hostOs !== "macos" || /Macintosh/.test(d.ua));
        return [ok, `distinct=${new Set(seen.map(x => JSON.stringify(x))).size} stored=${stored} audits=${audits.join(",")} mode=${mode} ${d.screen.join("x")} cores=${d.cores} ${d.webgl.slice(0, 30)} | ${replies.map(r => r.slice(10, 40)).join(" / ")}`];
      });
      await check("a temp profile still draws its own device", async () => {
        const seen = [], replies = [];
        for (let i = 0; i < 3; i++) {
          replies.push(idLine(await launch({ fresh_profile: true })));
          const { window, ...rest } = await device();
          seen.push(JSON.stringify(rest));
          await P.call("browser_close");
        }
        return [new Set(seen).size >= 2 && replies.every(r => /Identity: random/.test(r)), `distinct=${new Set(seen).size}/3 | ${replies[0]}`];
      });
      // camoufox-js writes the installed version into the user agent as it converts the
      // fingerprint, so an identity drawn under an older browser does not keep its version.
      // The stored WebGL pair is swapped for another one the OS has, so a launch that drew
      // its own GPU cannot pass by drawing the same one again (on macOS it nearly always does).
      await check("a kept device is the stored one, with the installed browser's version", async () => {
        const stored = readFileSync(idFile, "utf8");
        const id = JSON.parse(stored);
        const { sampleWebGL } = await import(pathToFileURL(join(ROOT, "node_modules", "camoufox-js", "dist", "webgl", "sample.js")).href);
        const code = { windows: "win", macos: "mac", linux: "lin" }[id.os];
        let pair = id.webgl;
        for (let i = 0; i < 200 && pair.join("/") === id.webgl.join("/"); i++) { const g = await sampleWebGL(code); pair = [g["webGl:vendor"], g["webGl:renderer"]]; }
        id.webgl = pair;
        writeFileSync(idFile, JSON.stringify(id).replace(/rv:\d+\.0/g, "rv:135.0").replace(/Firefox\/\d+\.0/g, "Firefox/135.0"), { mode: 0o600 });
        const reply = idLine(await launch());
        const d = await device();
        await P.call("browser_close");
        writeFileSync(idFile, stored, { mode: 0o600 });
        const ok = /kept this profile's device/.test(reply) && d.webgl === pair.join("/") && pair.join("/") !== JSON.parse(stored).webgl.join("/")
          && d.ua.includes(`rv:${major}.0`) && d.ua.includes(`Firefox/${major}.0`) && !d.ua.includes("135.0");
        return [ok, `${d.ua.slice(-30)} webgl=${d.webgl.slice(0, 40)} | ${reply.slice(0, 60)}`];
      });
      // A pair camoufox-js does not know made every launch of the profile fail with
      // "No WebGL data found", until reset_profile deleted its logins.
      await check("a stored device the browser cannot use is replaced, and the launch says so", async () => {
        const stored = readFileSync(idFile, "utf8");
        const id = JSON.parse(stored);
        id.webgl = ["Nobody Inc.", "Imaginary GPU"];
        writeFileSync(idFile, JSON.stringify(id), { mode: 0o600 });
        const unknown = await launch();
        await P.call("browser_close");
        writeFileSync(idFile, "{ not json", { mode: 0o600 });
        const broken = await launch();
        await P.call("browser_close");
        const ok = !unknown.startsWith("IS_ERROR") && /new device.*WebGL pair is not one camoufox-js knows/.test(idLine(unknown))
          && !broken.startsWith("IS_ERROR") && /new device.*could not be read/.test(idLine(broken)) && readIdentityOk(idFile);
        return [ok, `${idLine(unknown).slice(0, 110)} | ${idLine(broken).slice(10, 80)}`];
      });
      await check("another OS or a window the stored screen cannot hold draws a new device, and says so", async () => {
        const other = hostOs === "linux" ? "windows" : hostOs === "windows" ? "linux" : "windows";
        // With a window no screen holds, too: keeping the stored device then kept its OS.
        // The generator does not refuse such a window, it hands back a smaller screen, and
        // storing that drew a new device on every later launch at the same size.
        const foreign = idLine(await launch({ os: other, width: 5000, height: 3000 }));
        const foreignDevice = await device(), foreignUa = foreignDevice.ua;
        await P.call("browser_close");
        const again = idLine(await launch({ os: other, width: 5000, height: 3000 }));
        const againDevice = await device();
        await P.call("browser_close");
        const back = idLine(await launch());
        const backUa = (await device()).ua;
        await P.call("browser_close");
        // A stored screen smaller than the default window plus its 60px of menu bar.
        const id = JSON.parse(readFileSync(idFile, "utf8"));
        id.fingerprint.screen = { ...id.fingerprint.screen, width: 1366, height: 768, availWidth: 1366, availHeight: 768 };
        writeFileSync(idFile, JSON.stringify(id), { mode: 0o600 });
        const resized = idLine(await launch());
        const d = await device();
        await P.call("browser_close");
        const uaOs = ua => /Windows/.test(ua) ? "windows" : /Macintosh/.test(ua) ? "macos" : "linux";
        const ok = new RegExp(`new device.*os=${other} was asked`).test(foreign) && uaOs(foreignUa) === other
          && /kept this profile's device\. No screen holds a 5000x3000 window/.test(again) && JSON.stringify(againDevice) === JSON.stringify(foreignDevice)
          && new RegExp(`new device.*os=${hostOs} was asked`).test(back) && uaOs(backUa) === hostOs
          && /new device.*does not fit this profile's 1366x768 screen/.test(resized) && d.screen[1] >= 860 && d.window[1] <= d.screen[1];
        return [ok, `${foreign.slice(0, 80)} | ${again.slice(10, 70)} | ${back.slice(10, 70)} | ${resized.slice(10, 90)} | screen ${d.screen[0]}x${d.screen[1]}`];
      });
      await check("reset_profile removes the device with the logins", async () => {
        const before = existsSync(idFile);
        const wiped = await P.call("reset_profile");
        const after = existsSync(idFile);
        const reply = idLine(await launch());
        await P.call("browser_close");
        return [before && !after && /Profile wiped/.test(wiped) && /new device.*first launch/.test(reply), `before=${before} after=${after} | ${reply}`];
      });
    } finally {
      try { await P.call("browser_close"); } catch {}
      P.kill();
    }

    // ── Installing the browser ───────────────────────────────────────────────
    // `npx camoufox-js fetch` resolved to camoufox-js 0.13, whose cache layout 0.10
    // cannot read: a first launch downloaded 1.3 GB and then failed (issue #7).
    await check("the first-run download uses the camoufox-js this package depends on", async () => {
      const mod = await import(pathToFileURL(join(ROOT, "dist", "install.js")).href);
      const { command, args } = mod.bundledFetchCommand();
      const expected = join(ROOT, "node_modules", "camoufox-js", "dist", "__main__.js");
      return [command === process.execPath && args[0] === expected && existsSync(args[0]) && args[1] === "fetch", `${command === process.execPath ? "node" : command} ${args.join(" ").replace(ROOT, ".")}`];
    });
    // Deleting the browser to free disk space leaves version.json behind, and the
    // launch then died on "ENOENT ... properties.json".
    await check("a deleted browser is reported plainly, not as ENOENT", async () => {
      const home = mkdtempSync(join(tmpdir(), "mcp-camoufox-nobrowser-"));
      mkdirSync(camoufoxCache(home), { recursive: true });
      writeFileSync(join(camoufoxCache(home), "version.json"), JSON.stringify({ version: "158.0.1", release: "beta.41" }));
      const bare = await startServer(DIST, { home });
      try {
        const started = Date.now();
        const text = await bare.call("browser_launch", { ...LAUNCH, url: "about:blank" });
        const ms = Date.now() - started;
        return [text.startsWith("IS_ERROR") && /Camoufox is not installed/.test(text) && /camoufox-js@[\d.]+ fetch/.test(text) && !/ENOENT/.test(text) && ms < 5000, `${ms}ms ${text.slice(0, 110)}`];
      } finally { bare.kill(); try { rmSync(home, { recursive: true, force: true }); } catch {} }
    });
  } finally {
    try { if (S) await S.call("browser_close"); } catch {}
    if (fx) fx.close(); if (fx2) fx2.close(); if (S) S.kill();
  }
  return report();
}
