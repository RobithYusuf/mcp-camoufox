// The page the protocol tests drive. Every control records what really happened
// into window.__m, so a check can compare the tool's reply with the page.
import { fixtureServer, html } from "./harness.mjs";

// Invented for these tests. A check fails if one of them reaches a tool reply.
export const SECRET = {
  password: "sandi-uji-Q7w2Z9",
  cookie: "kuki-uji-K4m8P1x6",
  bearer: "bearer-uji-B3n7V5c2",
  token: "token-uji-T9r4L6y1",
  apiKey: "kunci-uji-A2s8D4f7",
};

const CARDS = [1, 2, 3, 4].map(i =>
  `<li class="card"><h3>Card ${i}</h3><span class="price">Harga ${i}00</span><a href="/c${i}">link${i}</a></li>`).join("");

const MAIN = html(`
<script>
window.__m = [];
function mark(x) { window.__m.push(x); }
var moved = false;
</script>
<h1>Audit Fixture</h1>
<div id="status">idle</div>
<button id="noop">NoOp</button>
<button id="counter" onclick="this.textContent='Count: ' + (++window.__n); mark('counter')">Count: 0</button>
<script>window.__n = 0;</script>
<button id="dis" disabled onclick="mark('dis')">DisabledBtn</button>
<button id="hid" onclick="mark('hid')">HideMe</button>
<div style="position:relative;display:inline-block">
  <button id="cov" onclick="mark('cov')">CoveredBtn</button>
  <div id="overlay" style="position:absolute;inset:0;background:rgba(0,0,0,.2)" onclick="mark('overlay')"></div>
</div>
<button id="rclick" oncontextmenu="mark('contextmenu');return false" onclick="mark('leftclick')">RightClickMe</button>
<div style="position:relative;display:inline-block">
  <button id="rcov" oncontextmenu="mark('rcov-contextmenu');return false" onclick="mark('rcov-leftclick')" ondblclick="mark('rcov-dbl')">CoveredMenu</button>
  <div style="position:absolute;inset:0;background:rgba(0,0,0,.2)"></div>
</div>
<button id="pop" onclick="window.open('/second?popup');mark('pop')">PopupBtn</button>
<button id="alertb" onclick="alert('halo-alert');mark('alert-returned')">AlertBtn</button>
<button id="confirmb" onclick="mark('confirm=' + confirm('yakin?'))">ConfirmBtn</button>
<button id="promptb" onclick="mark('prompt=' + prompt('nama?', ''))">PromptBtn</button>
<button id="moved" onmousemove="if(!moved){moved=true;alert('dari-mousemove');mark('move-dialog')}" onclick="mark('moved-click')">MoveDialog</button>
<button id="slowbtn" onclick="setTimeout(function(){document.getElementById('status').textContent='changed-late'},300)">SlowBtn</button>
<a id="nav" href="/second?viaLink=1">GoSecond</a>
<a id="navjs" href="#" onclick="setTimeout(function(){location.href='/second?late=1'},400);return false">GoLate</a>
<form id="f1" onsubmit="event.preventDefault();mark('submit');document.getElementById('status').textContent='submitted'">
  <label for="ta">Notes</label><textarea id="ta" name="notes"></textarea>
  <label for="txt">Nickname</label><input id="txt" name="nick" value="old">
  <input id="em" type="email" name="mail" value="old@x.test">
  <input id="num" type="number" name="qty" value="1">
  <label for="pw">Sandi</label><input id="pw" type="password" name="password" value="${SECRET.password}">
  <input id="ro" name="ro" readonly value="keep-ro">
  <input id="di" name="di" disabled value="keep-di">
  <select id="sel" name="sel"><option value="a">Alpha</option><option value="b">Beta</option></select>
  <input id="chk" type="checkbox" name="chk" onchange="mark('chk=' + this.checked)">
  <input id="rad" type="radio" name="rad">
  <input id="file" type="file" name="file">
  <label for="lab">Full Name</label><input id="lab" name="fullname" placeholder="Your name here">
  <button id="sub" type="submit">SubmitForm</button>
</form>
<input id="pw2" type="password" aria-label="Rahasia" value="${SECRET.password}">
<input id="pw3" type="password" aria-label="Rahasia" value="${SECRET.password}">
<div id="drag" draggable="true" style="width:80px;height:30px;background:#ccc"
  ondragstart="event.dataTransfer.setData('text/plain','x');mark('dragstart')">DragMe</div>
<div id="drop" style="width:120px;height:40px;background:#eee"
  ondragover="event.preventDefault()" ondrop="event.preventDefault();mark('drop')">DropHere</div>
<div id="wide" style="width:200px;height:40px;background:#def;position:relative"
  onclick="mark('wide@' + Math.round(event.offsetX) + ',' + Math.round(event.offsetY))">Wide</div>
<iframe name="fr" src="/frame" width="200" height="60"></iframe>
<table id="tbl"><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>Apple</td><td>3</td></tr><tr><td>Banana</td><td>5</td></tr></tbody></table>
<ul id="cards">${CARDS}</ul>
<a id="ext" href="https://example.invalid/x">ExternalLink</a>
<p id="para">Teks pencarian unik-xyz ada di sini.</p>
<div id="hover" onmouseover="mark('hover')">HoverMe</div>
<div style="height:2500px"></div>
<div id="bottom">Bottom</div>
<script>
document.addEventListener('keydown', function (e) { mark('key=' + e.key); });
document.addEventListener('mousemove', function (e) { window.__lastMove = [e.clientX, e.clientY]; });
</script>`, "Audit Fixture");

const send = (res, body, headers = {}, status = 200) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(body);
};
const json = (res, value, headers = {}, status = 200) =>
  send(res, JSON.stringify(value), { "content-type": "application/json", ...headers }, status);

const readBody = req => new Promise(resolve => {
  let b = ""; req.on("data", d => { b += d; }); req.on("end", () => resolve(b));
});

export async function auditFixture() {
  const seen = { posts: [], logins: [] };
  const fx = await fixtureServer({
    "/": (q, r) => send(r, MAIN),
    "/second": (q, r) => send(r, html(`<h1>Second Page</h1><p id="second">halaman kedua</p>`, "Second")),
    "/frame": (q, r) => send(r, html(`<div id="fd">frame-data</div>`, "F")),
    "/short": (q, r) => send(r, html(`<p>pendek</p>`, "Pendek")),
    "/tall": (q, r) => send(r, html(`<div style="height:4000px">tinggi</div><div id="end">akhir</div>`, "Tall")),
    "/article": (q, r) => send(r, html(`<main><h1>Artikel</h1><p>${"Isi artikel yang cukup panjang. ".repeat(80)}</p><a href="/second">baca</a></main>`, "Artikel")),
    "/blocked": (q, r) => send(r, html(`<h1>Just a moment...</h1><div class="cf-chl">checking your browser</div>`, "Just a moment..."), {}, 403),
    "/echo": async (q, r) => json(r, { method: q.method, url: q.url, headers: q.headers, body: await readBody(q) }),
    "/api.json": (q, r) => json(r,
      { access_token: SECRET.token, nested: { refresh_token: SECRET.token }, name: "tampil" },
      { "set-cookie": `api_session=${SECRET.cookie}; Path=/; HttpOnly`, "x-public": "tampil-juga" }),
    "/token-redirect": (q, r) => send(r, "", { location: `/second?access_token=${SECRET.token}&page=2` }, 302),
    "/calls": (q, r) => send(r, html(`<h1>Calls</h1><script>
      function fire() {
        return fetch('/api.json?access_token=${SECRET.token}&keep=1', { method: 'POST',
          headers: { Authorization: 'Bearer ${SECRET.bearer}', 'X-Api-Key': '${SECRET.apiKey}', 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: '${SECRET.password}', note: 'boleh' }) }).then(function (x) { return x.text(); });
      }
    </script>`, "Calls")),
    "/slow": (q, r) => setTimeout(() => json(r, { ok: true }), 800),
    "/calls-slow": (q, r) => send(r, html(`<h1>SlowCalls</h1><script>setTimeout(function () { fetch('/slow'); }, 200);</script>`, "SlowCalls")),
    "/login": (q, r) => send(r, html(`<form method="post" action="/login-done">
      <input type="email" name="email"><input type="password" name="password"><button type="submit">Sign in</button></form>`, "Login")),
    "/login-done": async (q, r) => { seen.logins.push(await readBody(q)); send(r, html(`<h1>Welcome</h1>`, "Welcome")); },
    "/nofields": (q, r) => send(r, html(`<p>tanpa form</p>`, "NoFields")),
    "/two-step": (q, r) => send(r, html(`<input id="a" aria-label="Alpha field" value=""><button onclick="window.__c=(window.__c||0)+1">Go</button>`, "Two")),
    // Local stand-ins for a challenge widget. Nothing here talks to Cloudflare.
    "/ts-never": (q, r) => send(r, html(`<div class="cf-turnstile" data-sitekey="3x00000000000000000000FF" style="width:300px;height:65px;background:#eee"></div>
      <input type="hidden" name="cf-turnstile-response" value="">`, "Widget Never")),
    "/ts-dummy": (q, r) => send(r, html(`<div id="w" class="cf-turnstile" data-sitekey="1x00000000000000000000AA" style="width:300px;height:65px;background:#eee"
        onclick="document.getElementById('t').value='XXXX.DUMMY.TOKEN.XXXX.DUMMY.TOKEN'"></div>
      <input id="t" type="hidden" name="cf-turnstile-response" value="">`, "Just a moment...")),
    "/ts-pass": (q, r) => send(r, html(`<div id="w" class="cf-turnstile" data-sitekey="0x4AAAAAAAlocalfixture" style="width:300px;height:65px;background:#eee"
        onclick="document.getElementById('t').value='${"a".repeat(64)}';document.title='Halaman Asli'"></div>
      <input id="t" type="hidden" name="cf-turnstile-response" value="">`, "Verifikasi")),
    "/searx/search": (q, r) => json(r, { results: [{ title: "Hasil", url: "http://x.test/a", content: "isi", engine: "lokal" }] }),
    "/searx-empty/search": (q, r) => json(r, { results: [] }),
    "/searx-odd/search": (q, r) => json(r, { items: [] }),
    "*": (q, r) => send(r, "tidak ada", {}, 404),
  });
  return { ...fx, seen };
}
