#!/usr/bin/env node
// Sweep EVERY registered tool over a real MCP client against a real browser: one
// success path and one reasonable failure path per tool, with the effect read back
// from the page rather than from the reply.
//
//   node scripts/test/sweep.mjs [report.md]
//
// Exits non-zero when a tool misbehaves, when a tool has no entry here, or when an
// entry names a tool that no longer exists, so a new tool cannot skip the sweep.
// Local fixtures only, in a sandboxed HOME: see protocol.mjs.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import Ajv from "ajv";
import { connect, LOCAL_LAUNCH, isAlive } from "./protocol.mjs";
import { auditFixture, SECRET } from "./fixture-audit.mjs";
import { refOf, until } from "./harness.mjs";

const REPORT = process.argv[2] || "";
const SECRETS = Object.values(SECRET);
const leaked = text => SECRETS.filter(s => String(text).includes(s));
const short = v => String(v ?? "").replace(/\s+/g, " ").slice(0, 170);
const work = mkdtempSync(join(tmpdir(), "mcp-camoufox-sweep-"));

let fx, M;   // fixture, main client
let c;       // main client's call()

const ev = async expr => (await c("evaluate", { expression: expr })).first;
const evj = async expr => JSON.parse(await ev(`JSON.stringify(${expr})`));
const marks = () => evj("window.__m");
const snap = async () => (await c("browser_snapshot", { limit: 0 })).text;
const ref = async needle => refOf(await snap(), needle);

/** Back to one tab on a fresh copy of the fixture page. */
async function home(path = "/") {
  const list = await c("tab_list");
  const count = Number((list.text.match(/Tabs \((\d+)\)/) || [])[1] || 0);
  for (let i = count - 1; i > 0; i--) await c("tab_close", { index: i });
  await c("tab_select", { index: 0 });
  const r = await c("navigate", { url: fx.url + path });
  if (r.isError) throw new Error("could not return to the fixture: " + short(r.text));
}

// ── Per-tool checks: each returns [passed, detail] ──────────────────────────
const T = {};

T.browser_launch = {
  ok: async () => {
    const r = await c("server_status");
    return [JSON.parse(r.text).browser_up === true && (await ev("location.pathname")) === "/", short(r.text)];
  },
  fail: async () => {
    const s = await connect();
    try {
      const r = await s.call("browser_launch", { ...LOCAL_LAUNCH, url: "http://127.0.0.1:1/" });
      return [r.isError, short(r.text)];
    } finally { await s.close(); }
  },
};
T.browser_close = {
  ok: async () => {
    const s = await connect();
    try {
      await s.call("browser_launch", LOCAL_LAUNCH);
      const before = s.browsers().length;
      const r = await s.call("browser_close");
      const gone = await until(() => s.browsers().length === 0, 8000);
      const left = readdirSync(join(s.home, ".camoufox-mcp")).filter(n => n.startsWith("profile-fresh-"));
      return [before === 1 && gone && left.length === 0 && !r.isError, `before=${before} gone=${gone} tempLeft=${left.length} ${short(r.text)}`];
    } finally { await s.close(); }
  },
  // Nothing was running, so "Browser closed. Profile saved." would be a claim about
  // something that never happened.
  fail: async () => {
    const s = await connect();
    try {
      const r = await s.call("browser_close");
      return [!/^Browser closed/.test(r.text) && /not running|no browser|nothing/i.test(r.text), short(r.text)];
    } finally { await s.close(); }
  },
};
T.reset_profile = {
  ok: async () => {
    const s = await connect();
    try {
      await s.call("browser_launch", { headless: true, geoip: false });
      await s.call("browser_close");
      const dir = join(s.home, ".camoufox-mcp", "profile");
      const had = existsSync(dir);
      const r = await s.call("reset_profile");
      return [had && !existsSync(dir) && !r.isError, `had=${had} ${short(r.text)}`];
    } finally { await s.close(); }
  },
  fail: async () => { const r = await c("reset_profile"); return [r.isError, short(r.text)]; },
};
T.navigate = {
  ok: async () => {
    const r = await c("navigate", { url: fx.url + "/second" });
    return [(await ev("document.getElementById('second').textContent")) === "halaman kedua" && !r.isError, short(r.text)];
  },
  fail: async () => { const r = await c("navigate", { url: "http://127.0.0.1:1/" }); return [r.isError, short(r.text)]; },
};
T.go_back = {
  ok: async () => {
    await home(); await c("navigate", { url: fx.url + "/second" });
    const r = await c("go_back");
    return [(await ev("location.pathname")) === "/" && !r.isError, short(r.text)];
  },
  // A fresh tab has nowhere to go back to, so "Went back." would be false.
  fail: async () => {
    await c("tab_new", { url: fx.url + "/second" });
    const r = await c("go_back");
    return [r.isError || /no (previous|history|page)|nothing/i.test(r.text), short(r.text)];
  },
};
T.go_forward = {
  ok: async () => {
    await home(); await c("navigate", { url: fx.url + "/second" }); await c("go_back");
    const r = await c("go_forward");
    return [(await ev("location.pathname")) === "/second" && !r.isError, short(r.text)];
  },
  fail: async () => {
    await c("tab_new", { url: fx.url + "/second" });
    const r = await c("go_forward");
    return [r.isError || /no (next|forward|history|page)|nothing/i.test(r.text), short(r.text)];
  },
};
T.reload = {
  ok: async () => {
    await ev("window.__gone = 1; 1");
    const r = await c("reload");
    return [(await ev("typeof window.__gone")) === "undefined" && !r.isError, short(r.text)];
  },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("reload"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.browser_snapshot = {
  ok: async () => {
    const t = await snap();
    return [t.includes("NoOp") && t.includes("ref=e") && !leaked(t).length, `chars=${t.length} leaked=${leaked(t).length}`];
  },
  // A ref has to name exactly one element, the one the latest snapshot listed. Refs were
  // attributes once: a hidden element kept its old one, the same ref then named two
  // elements and `.first()` could pick the hidden one. They live in a registry now, so
  // the document must carry no ref attribute at all, and the ref must still work.
  fail: async () => {
    await home();
    await snap();
    await ev(`(function () { var a = document.getElementById('noop'); a.style.display = 'none'; })()`);
    const refCounter = refOf(await snap(), "Count: 0");
    const attrs = await evj(`document.querySelectorAll('[data-mcp-ref]').length`);
    const before = await ev("String(window.__n)");
    const r = await c("click", { ref: refCounter });
    const after = await ev("String(window.__n)");
    return [attrs === 0 && !r.isError && Number(after) === Number(before) + 1, `ref attributes in the document: ${attrs}; ${refCounter} clicked the counter ${before} -> ${after}`];
  },
};
T.screenshot = {
  ok: async () => {
    const r = await c("screenshot", { name: "sweep" });
    const path = (r.text.match(/saved: (\S+)/) || [])[1];
    const head = path && existsSync(path) ? readFileSync(path).subarray(1, 4).toString() : "";
    return [r.kinds.includes("image") && head === "PNG", `${r.kinds.join("+")} ${short(path)}`];
  },
  fail: async () => { const r = await c("screenshot", { selector: "#tidak-ada" }); return [r.isError, short(r.text)]; },
};
T.click = {
  ok: async () => {
    const r = await c("click", { ref: await ref("Count: 0") });
    const n = await ev("window.__n");
    return [n === "1" && !r.isError && !/no (page )?change/i.test(r.text), `counter=${n} ${short(r.text)}`];
  },
  fail: async () => { const r = await c("click", { ref: "e99999" }); return [r.isError, `${r.seconds}s ${short(r.text)}`]; },
};
T.click_text = {
  ok: async () => {
    const r = await c("click_text", { text: "Count: 0" });
    return [(await ev("window.__n")) === "1" && !r.isError, short(r.text)];
  },
  fail: async () => { const r = await c("click_text", { text: "tidak-ada-teks" }); return [r.isError, short(r.text)]; },
};
T.click_role = {
  ok: async () => {
    const r = await c("click_role", { role: "button", name: "Count: 0" });
    return [(await ev("window.__n")) === "1" && !r.isError, short(r.text)];
  },
  fail: async () => { const r = await c("click_role", { role: "button", name: "tidak-ada" }); return [r.isError, short(r.text)]; },
};
T.hover = {
  ok: async () => {
    const r = await c("hover", { ref: await ref("Count: 0") });
    await c("scroll_to", { selector: "#hover" });
    const a = await c("evaluate", { expression: "document.getElementById('hover').setAttribute('data-mcp-ref','hv');1" });
    const h = await c("hover", { ref: "hv" });
    return [(await marks()).includes("hover") && !r.isError && !h.isError && !a.isError, short(h.text)];
  },
  fail: async () => { const r = await c("hover", { ref: "e99999" }); return [r.isError, short(r.text)]; },
};
T.fill = {
  ok: async () => {
    const taRef = await ref("[textarea]");
    await c("fill", { ref: taRef, value: "baris satu\nbaris dua" });
    const ta = await ev("document.getElementById('ta').value");
    await ev("document.getElementById('em').setAttribute('data-mcp-ref','em1');1");
    await c("fill", { ref: "em1", value: "baru@x.test" });
    const em = await ev("document.getElementById('em').value");
    return [ta === "baris satu\nbaris dua" && em === "baru@x.test", `ta=${JSON.stringify(ta)} em=${em}`];
  },
  // A failed fill must leave the field as it was. fillLocator clears first, so a
  // disabled or readonly field could lose its value while the tool reports failure.
  fail: async () => {
    await ev("document.getElementById('di').setAttribute('data-mcp-ref','di1');document.getElementById('ro').setAttribute('data-mcp-ref','ro1');1");
    const a = await c("fill", { ref: "di1", value: "x" });
    const b = await c("fill", { ref: "ro1", value: "x" });
    const v = await evj("[document.getElementById('di').value, document.getElementById('ro').value]");
    return [a.isError && b.isError && v[0] === "keep-di" && v[1] === "keep-ro", `err=${a.isError},${b.isError} values=${v} `];
  },
};
T.select_option = {
  ok: async () => {
    const r = await ev("document.getElementById('sel').setAttribute('data-mcp-ref','s1');1");
    const s = await c("select_option", { ref: "s1", value: "b" });
    return [(await ev("document.getElementById('sel').value")) === "b" && !s.isError && r === "1", short(s.text)];
  },
  fail: async () => {
    const s = await c("select_option", { ref: "s1", value: "tidak-ada" });
    return [s.isError && (await ev("document.getElementById('sel').value")) === "b", short(s.text)];
  },
};
T.check = {
  ok: async () => {
    await ev("document.getElementById('chk').setAttribute('data-mcp-ref','c1');1");
    const r = await c("check", { ref: "c1" });
    return [(await ev("document.getElementById('chk').checked")) === "true" && !r.isError, short(r.text)];
  },
  fail: async () => { const r = await c("check", { ref: "e99999" }); return [r.isError, short(r.text)]; },
};
T.uncheck = {
  ok: async () => {
    await ev("var u=document.getElementById('chk');u.setAttribute('data-mcp-ref','c1');u.checked=true;1");
    const r = await c("uncheck", { ref: "c1" });
    return [(await ev("document.getElementById('chk').checked")) === "false" && !r.isError, short(r.text)];
  },
  fail: async () => {
    await ev("document.getElementById('rad').setAttribute('data-mcp-ref','r1');document.getElementById('rad').checked=true;1");
    const r = await c("uncheck", { ref: "r1" });
    return [r.isError, short(r.text)];
  },
};
T.type_text = {
  ok: async () => {
    await home();
    await ev("document.getElementById('txt').focus();document.getElementById('txt').value='';1");
    const r = await c("type_text", { text: "halo", delay: 0 });
    return [(await ev("document.getElementById('txt').value")) === "halo" && !r.isError, short(r.text)];
  },
  // Keys typed with nothing focused go nowhere, and "Typed" says they arrived.
  fail: async () => {
    await ev("document.activeElement && document.activeElement.blur();1");
    const r = await c("type_text", { text: "kosong", delay: 0 });
    return [r.isError || /no (editable|field|focus)|not focused|nothing/i.test(r.text), short(r.text)];
  },
};
T.press_key = {
  ok: async () => {
    const r = await c("press_key", { key: "Escape" });
    return [(await marks()).includes("key=Escape") && !r.isError, short(r.text)];
  },
  fail: async () => { const r = await c("press_key", { key: "BukanTombol" }); return [r.isError, short(r.text)]; },
};
T.wait_for = {
  ok: async () => {
    await ev("setTimeout(function(){var d=document.createElement('div');d.id='late';d.textContent='muncul';document.body.prepend(d)},200);1");
    const r = await c("wait_for", { selector: "#late", timeout: 4000 });
    return [!r.isError && (await ev("!!document.getElementById('late')")) === "true", short(r.text)];
  },
  fail: async () => { const r = await c("wait_for", { selector: "#tidak-ada", timeout: 300 }); return [r.isError, short(r.text)]; },
};
T.wait_for_navigation = {
  ok: async () => {
    await home();
    await ev("setTimeout(function(){location.href='/second?w=1'},200);1");
    const r = await c("wait_for_navigation", { timeout: 5000 });
    return [!r.isError && (await until(async () => (await ev("location.search")) === "?w=1", 3000)), short(r.text)];
  },
  // Nothing navigates here, so "Navigation complete" would be invented.
  fail: async () => {
    await new Promise(r => setTimeout(r, 2100));   // past the window that counts a navigation just finished
    const r = await c("wait_for_navigation", { timeout: 800 });
    return [r.isError || /no navigation/i.test(r.text), `${r.seconds}s ${short(r.text)}`];
  },
};
T.wait_for_any_of = {
  ok: async () => {
    await c("navigate", { url: fx.url + "/second" });
    const r = await c("wait_for_any_of", { conditions: [{ kind: "selector", value: "#tidak" }, { kind: "text", value: "halaman kedua" }], timeout: 3000 });
    return [/index=1/.test(r.text) && !r.isError, short(r.text)];
  },
  fail: async () => {
    const r = await c("wait_for_any_of", { conditions: [{ kind: "selector", value: "#tidak" }], timeout: 300 });
    return [r.isError, short(r.text)];
  },
};
T.evaluate = {
  ok: async () => {
    const r = await c("evaluate", { expression: "1 + 1" });
    return [r.text === "2" && !r.isError, r.text];
  },
  fail: async () => {
    const a = await c("evaluate", { expression: "throw new Error('sengaja')" }).catch(e => ({ isError: true, text: "RPC " + e.message }));
    const b = await c("evaluate", { expression: "(function(){ throw new Error('sengaja2') })()" });
    const d = await c("evaluate", { expression: "Promise.reject(new Error('ditolak'))" });
    return [a.isError && b.isError && d.isError, `${a.isError},${b.isError},${d.isError} ${short(d.text)}`];
  },
};
T.get_url = {
  ok: async () => { const r = await c("get_url"); return [r.text.includes(fx.url), short(r.text)]; },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("get_url"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.get_text = {
  ok: async () => { await home(); const r = await c("get_text", { selector: "#para" }); return [r.text.includes("unik-xyz"), short(r.text)]; },
  fail: async () => { const r = await c("get_text", { selector: "#tidak" }); return [r.isError, short(r.text)]; },
};
T.get_html = {
  ok: async () => { const r = await c("get_html", { selector: "#para", outer: true }); return [r.text.startsWith("<p"), short(r.text)]; },
  fail: async () => { const r = await c("get_html", { selector: "#tidak" }); return [r.isError, short(r.text)]; },
};
T.tab_list = {
  ok: async () => { const r = await c("tab_list"); return [/Tabs \(1\)/.test(r.text) && /\(active\)/.test(r.text), short(r.text)]; },
  fail: async () => {
    const s = await connect();
    try {
      const r = await s.call("tab_list");
      return [r.isError || /not running|no tabs|\(0\)/i.test(r.text), short(r.text)];
    } finally { await s.close(); }
  },
};
T.tab_new = {
  ok: async () => {
    const r = await c("tab_new", { url: fx.url + "/second" });
    return [(await ev("location.pathname")) === "/second" && /\[1\]/.test(r.text), short(r.text)];
  },
  fail: async () => { const r = await c("tab_new", { url: "http://127.0.0.1:1/" }); return [r.isError, short(r.text)]; },
};
T.tab_select = {
  ok: async () => {
    await home(); await c("tab_new", { url: fx.url + "/second" });
    const r = await c("tab_select", { index: 0 });
    return [(await ev("location.pathname")) === "/" && !r.isError, short(r.text)];
  },
  fail: async () => {
    const a = await c("tab_select", { index: 99 });
    const b = await c("tab_select", { url_contains: "tidak-ada-url" });
    return [a.isError && b.isError, `${a.isError},${b.isError} ${short(a.text)}`];
  },
};
T.tab_close = {
  ok: async () => {
    await home(); await c("tab_new", { url: fx.url + "/second" });
    const r = await c("tab_close", { index: 1 });
    return [/Tabs \(1\)/.test((await c("tab_list")).text) && !r.isError, short(r.text)];
  },
  fail: async () => {
    const a = await c("tab_close", { index: 99 });
    const b = await c("tab_close", { url_contains: "tidak-ada-url" });
    return [a.isError && b.isError, `${a.isError},${b.isError} ${short(a.text)}`];
  },
};
const host = () => new URL(fx.url).hostname;
T.cookie_set = {
  ok: async () => {
    const r = await c("cookie_set", { name: "satu", value: SECRET.cookie, domain: host() });
    return [(await ev("document.cookie")).includes(SECRET.cookie) && !leaked(r.text).length, short(r.text)];
  },
  fail: async () => {
    const r = await c("cookie_set", { name: "dua", value: "v", domain: host(), same_site: "None" });
    return [r.isError, short(r.text)];
  },
};
T.cookie_list = {
  ok: async () => {
    const r = await c("cookie_list");
    return [r.text.includes("satu") && !leaked(r.text).length, short(r.text)];
  },
  fail: async () => { const r = await c("cookie_list", { domain: "tidak-ada.test" }); return [/No cookies/i.test(r.text), short(r.text)]; },
};
T.cookie_delete = {
  ok: async () => {
    await c("cookie_set", { name: "hapus", value: "1", domain: host() });
    await c("cookie_set", { name: "simpan", value: "2", domain: host() });
    const r = await c("cookie_delete", { name: "hapus" });
    const left = await ev("document.cookie");
    return [!left.includes("hapus=") && left.includes("simpan=") && /1/.test(r.text) && !r.isError, `${short(r.text)} | left: ${short(left.replace(SECRET.cookie, "***"))}`];
  },
  fail: async () => {
    const r = await c("cookie_delete", { name: "tidak-pernah-ada" });
    return [/\b0\b|none|no cookie/i.test(r.text), short(r.text)];
  },
};
T.dialog_handle = {
  ok: async () => {
    await home();
    await c("dialog_handle", { action: "accept" });
    await c("click_text", { text: "ConfirmBtn" });
    return [(await marks()).includes("confirm=true"), JSON.stringify(await marks())];
  },
  fail: async () => {
    await c("dialog_handle", { action: "dismiss" });
    await c("click_text", { text: "ConfirmBtn" });
    return [(await marks()).includes("confirm=false"), JSON.stringify(await marks())];
  },
};
T.dialog_auto_handle = {
  ok: async () => {
    await home();
    await c("dialog_auto_handle", { action: "accept", prompt_text: "isi" });
    await c("click_text", { text: "PromptBtn" });
    await c("dialog_auto_handle", { enabled: false });
    return [(await marks()).includes("prompt=isi"), JSON.stringify(await marks())];
  },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("dialog_auto_handle", {}); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.upload_file = {
  ok: async () => {
    const f = join(work, "unggah.txt"); writeFileSync(f, "isi");
    await ev("document.getElementById('file').setAttribute('data-mcp-ref','up');1");
    const r = await c("upload_file", { ref: "up", file_path: f });
    return [(await ev("document.getElementById('file').files[0].name")) === "unggah.txt" && !r.isError, short(r.text)];
  },
  fail: async () => { const r = await c("upload_file", { ref: "up", file_path: join(work, "tidak-ada.txt") }); return [r.isError, short(r.text)]; },
};
T.turnstile_coords = {
  ok: async () => {
    await home("/ts-never");
    const r = await c("turnstile_coords", { wait_render_ms: 0 });
    const d = JSON.parse(r.text);
    return [d.x > 0 && d.y > 0 && !r.isError, short(r.text)];
  },
  fail: async () => {
    await home("/short");
    const r = await c("turnstile_coords", { wait_render_ms: 0 });
    return [r.isError, short(r.text)];
  },
};
T.os_click_xy = { skip: "moves the real cursor and clicks on the developer's screen while they are typing; only the no-browser error is checked" };
const REAL_SITE = "drives chatgpt.com with a real logged-in account; the brief forbids real sites and profiles with logins";
T.chatgpt_generate_image = { skip: REAL_SITE };
T.chatgpt_generate_batch = { skip: REAL_SITE };
T.scroll = {
  ok: async () => {
    await home();
    const r = await c("scroll", { direction: "down", amount: 300 });
    return [Number(await ev("Math.round(scrollY)")) === 300 && !r.isError, short(r.text)];
  },
  // The page cannot scroll, so "Scrolled down 500px" would be false.
  fail: async () => {
    await home("/short");
    const r = await c("scroll", { direction: "down", amount: 500 });
    return [r.isError || /did not move|no movement|0px|moved 0/i.test(r.text), short(r.text)];
  },
};
T.console_start = {
  ok: async () => {
    await home();
    const r = await c("console_start");
    await ev("console.log('halo-konsol');1");
    const got = await until(async () => (await c("console_get")).text.includes("halo-konsol"), 3000);
    return [got && !r.isError, short(r.text)];
  },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("console_start"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.console_get = {
  ok: async () => { const r = await c("console_get"); return [r.text.includes("halo-konsol"), short(r.text)]; },
  // "No messages." with no capture running reads like a quiet page.
  fail: async () => {
    const s = await connect();
    try {
      await s.call("browser_launch", LOCAL_LAUNCH);
      const r = await s.call("console_get");
      return [/not (started|capturing|running)|console_start/i.test(r.text), short(r.text)];
    } finally { await s.close(); }
  },
};
T.network_start = {
  ok: async () => {
    await home("/calls");
    const r = await c("network_start", { capture_bodies: true });
    await ev("fire()");
    const got = await until(async () => (await c("network_get", { filter: "api.json" })).text.includes("api.json"), 3000);
    return [got && !r.isError, short(r.text)];
  },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("network_start"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.network_get = {
  ok: async () => {
    const r = await c("network_get", { filter: "api.json" });
    return [r.text.includes("/api.json") && r.text.includes("keep=1") && !leaked(r.text).length, short(r.text)];
  },
  fail: async () => {
    const s = await connect();
    try {
      await s.call("browser_launch", LOCAL_LAUNCH);
      const r = await s.call("network_get");
      return [/not (started|capturing|running)|network_start/i.test(r.text), short(r.text)];
    } finally { await s.close(); }
  },
};
T.network_get_detail = {
  ok: async () => {
    const r = await c("network_get_detail", { url: "api.json" });
    const shown = await c("network_get_detail", { url: "api.json", reveal_values: true });
    return [r.text.includes("x-public") && !leaked(r.text).length && shown.text.includes(SECRET.bearer), `leaked=${leaked(r.text).length} revealWorks=${shown.text.includes(SECRET.bearer)}`];
  },
  fail: async () => { const r = await c("network_get_detail", { id: 99999 }); return [r.isError, short(r.text)]; },
};
T.save_pdf = {
  ok: async () => {
    const r = await c("save_pdf", { path: join(work, "x.pdf") });
    return [r.isError && /screenshot/.test(r.text), short(r.text)];
  },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("save_pdf"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.batch_actions = {
  ok: async () => {
    await home();
    await snap();
    const cnt = await ref("Count: 0");
    const r = await c("batch_actions", { actions: [{ type: "click", ref: cnt }, { type: "wait", timeout: 10 }] });
    return [(await ev("window.__n")) === "1" && !r.isError, short(r.text)];
  },
  fail: async () => {
    await home();
    const cnt = await ref("Count: 0");
    const r = await c("batch_actions", { actions: [{ type: "fill", ref: "e99999", value: "x" }, { type: "click", ref: cnt }] });
    const bad = await c("batch_actions", { actions: [{ type: "click" }] });
    return [r.isError && (await ev("window.__n")) === "0" && bad.isError, `isError=${r.isError} ranOn=${await ev("window.__n")} missingRef=${bad.isError} ${short(r.text)}`];
  },
};
T.fill_form = {
  ok: async () => {
    await home();
    await ev("document.getElementById('txt').setAttribute('data-mcp-ref','t1');document.getElementById('sub').setAttribute('data-mcp-ref','sb');1");
    const r = await c("fill_form", { fields: [{ ref: "t1", value: "budi" }], submit_ref: "sb" });
    return [(await marks()).includes("submit") && (await ev("document.getElementById('txt').value")) === "budi", short(r.text)];
  },
  fail: async () => {
    await home();
    await ev("document.getElementById('txt').setAttribute('data-mcp-ref','t1');document.getElementById('sub').setAttribute('data-mcp-ref','sb');document.getElementById('di').setAttribute('data-mcp-ref','d1');1");
    const r = await c("fill_form", { fields: [{ ref: "t1", value: "budi" }, { ref: "d1", value: SECRET.password }], submit_ref: "sb" });
    return [r.isError && !(await marks()).includes("submit") && !leaked(r.text).length, `isError=${r.isError} marks=${JSON.stringify(await marks())} ${short(r.text)}`];
  },
};
T.login_classic = {
  ok: async () => {
    await home("/login");
    const r = await c("login_classic", { email: "a@x.test", password: SECRET.password, submit_after_email: false, step_timeout_ms: 2000 });
    const posted = fx.seen.logins.some(b => b.includes("a%40x.test"));
    return [posted && !leaked(r.text).length && !r.isError, `posted=${posted} ${short(r.text)}`];
  },
  fail: async () => {
    await home("/nofields");
    const r = await c("login_classic", { email: "a@x.test", password: SECRET.password, step_timeout_ms: 300 });
    return [r.isError && !leaked(r.text).length, short(r.text)];
  },
};
T.navigate_and_snapshot = {
  ok: async () => { const r = await c("navigate_and_snapshot", { url: fx.url + "/" }); return [r.text.includes("NoOp"), `chars=${r.text.length}`]; },
  fail: async () => { const r = await c("navigate_and_snapshot", { url: "http://127.0.0.1:1/" }); return [r.isError, short(r.text)]; },
};
T.intercept_start = {
  ok: async () => {
    await home("/calls");
    const r = await c("intercept_start", { block_urls: ["api.json"] });
    const res = await ev("fire().then(function(){return 'lewat'},function(){return 'diblok'})");
    return [res === "diblok" && !r.isError, `${res} ${short(r.text)}`];
  },
  fail: async () => { const r = await c("intercept_start", {}); return [r.isError, short(r.text)]; },
};
T.intercept_log = {
  ok: async () => {
    const r = await c("intercept_log", { action: "all" });
    return [r.text.includes("api.json") && r.text.includes("keep=1") && !leaked(r.text).length, short(r.text)];
  },
  fail: async () => {
    const s = await connect();
    try {
      await s.call("browser_launch", LOCAL_LAUNCH);
      const r = await s.call("intercept_log");
      return [/not active/i.test(r.text), short(r.text)];
    } finally { await s.close(); }
  },
};
T.intercept_stop = {
  ok: async () => {
    await home("/calls");
    const r = await c("intercept_stop");
    const res = await ev("fire().then(function(){return 'lewat'},function(){return 'diblok'})");
    return [res === "lewat" && !r.isError, `${res} ${short(r.text)}`];
  },
  fail: async () => { const r = await c("intercept_stop"); return [/not active/i.test(r.text), short(r.text)]; },
};
T.export_curl = {
  ok: async () => {
    const r = await c("export_curl", { url_contains: "api.json" });
    const shown = await c("export_curl", { url_contains: "api.json", reveal_values: true });
    return [r.text.startsWith("#") && r.text.includes("curl") && !leaked(r.text).length && shown.text.includes(SECRET.bearer),
      `leaked=${leaked(r.text).length} revealWorks=${shown.text.includes(SECRET.bearer)}`];
  },
  fail: async () => { const r = await c("export_curl", { url_contains: "tidak-ada" }); return [r.isError, short(r.text)]; },
};
T.inspect_element = {
  ok: async () => {
    await home();
    await ev("document.getElementById('pw').setAttribute('data-mcp-ref','p1');document.getElementById('pw').setAttribute('value','" + SECRET.password + "');1");
    const r = await c("inspect_element", { ref: "p1" });
    return [r.text.includes('"tag": "input"') && !leaked(r.text).length, `leaked=${leaked(r.text).length}`];
  },
  fail: async () => { const r = await c("inspect_element", { ref: "e99999" }); return [r.isError, `${r.seconds}s ${short(r.text)}`]; },
};
T.get_attribute = {
  ok: async () => {
    await ev("var g=document.getElementById('pw');g.setAttribute('data-mcp-ref','p1');g.setAttribute('value','" + SECRET.password + "');1");
    const r = await c("get_attribute", { ref: "p1", attribute: "name" });
    const v = await c("get_attribute", { ref: "p1", attribute: "value" });
    return [r.text === "name=password" && !leaked(v.text).length, `${r.text} | value→${short(v.text.replace(SECRET.password, "<BOCOR>"))}`];
  },
  fail: async () => { const r = await c("get_attribute", { ref: "e99999", attribute: "x" }); return [r.isError, `${r.seconds}s ${short(r.text)}`]; },
};
T.query_selector_all = {
  ok: async () => {
    const r = await c("query_selector_all", { selector: ".card h3" });
    const v = await c("query_selector_all", { selector: "#pw", attribute: "value" });
    return [JSON.parse(r.text).total === 4 && !leaked(v.text).length, `total=${JSON.parse(r.text).total} leaked=${leaked(v.text).length}`];
  },
  fail: async () => { const r = await c("query_selector_all", { selector: "[[[" }); return [r.isError, short(r.text)]; },
};
T.get_links = {
  ok: async () => { const r = await c("get_links", { filter: "viaLink" }); return [r.text.includes("GoSecond"), short(r.text)]; },
  fail: async () => { const r = await c("get_links", { filter: "tidak-ada" }); return [/\(0\)/.test(r.text), short(r.text)]; },
};
T.localstorage_set = {
  ok: async () => { const r = await c("localstorage_set", { key: "k1", value: "v1" }); return [(await ev("localStorage.getItem('k1')")) === "v1" && !r.isError, short(r.text)]; },
  fail: async () => {
    await c("navigate", { url: "about:blank" });
    const r = await c("localstorage_set", { key: "k", value: "v" });
    await home();
    return [r.isError, short(r.text)];
  },
};
T.localstorage_get = {
  ok: async () => {
    await c("localstorage_set", { key: "k1", value: "v1" });
    const r = await c("localstorage_get");
    const one = await c("localstorage_get", { key: "k1" });
    return [r.text.includes("v1") && one.text === "k1=v1", short(r.text)];
  },
  fail: async () => {
    const r = await c("localstorage_get", { key: "tidak-ada" });
    return [/null|not (set|found)/i.test(r.text), short(r.text)];
  },
};
T.localstorage_clear = {
  ok: async () => { const r = await c("localstorage_clear"); return [(await ev("localStorage.length")) === "0" && !r.isError, short(r.text)]; },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("localstorage_clear"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.sessionstorage_set = {
  ok: async () => { const r = await c("sessionstorage_set", { key: "s1", value: "v1" }); return [(await ev("sessionStorage.getItem('s1')")) === "v1" && !r.isError, short(r.text)]; },
  fail: async () => {
    await c("navigate", { url: "about:blank" });
    const r = await c("sessionstorage_set", { key: "k", value: "v" });
    await home();
    return [r.isError, short(r.text)];
  },
};
T.sessionstorage_get = {
  ok: async () => {
    await c("sessionstorage_set", { key: "s1", value: "v1" });
    const r = await c("sessionstorage_get");
    return [r.text.includes("v1"), short(r.text)];
  },
  fail: async () => { const r = await c("sessionstorage_get", { key: "tidak-ada" }); return [/null|not (set|found)/i.test(r.text), short(r.text)]; },
};
T.sessionstorage_clear = {
  ok: async () => { const r = await c("sessionstorage_clear"); return [(await ev("sessionStorage.length")) === "0" && !r.isError, short(r.text)]; },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("sessionstorage_clear"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
const center = async id => evj(`(function(){var r=document.getElementById('${id}').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
T.mouse_click_xy = {
  ok: async () => {
    await home();
    const p = await center("counter");
    const r = await c("mouse_click_xy", p);
    return [(await ev("window.__n")) === "1" && !r.isError, short(r.text)];
  },
  // A click at a spot outside the viewport reaches nothing.
  fail: async () => {
    const r = await c("mouse_click_xy", { x: -500, y: -500 });
    return [r.isError || /outside/i.test(r.text), short(r.text)];
  },
};
T.mouse_move = {
  ok: async () => {
    const r = await c("mouse_move", { x: 120, y: 90 });
    const at = await evj("window.__lastMove");
    return [at && at[0] === 120 && at[1] === 90 && !r.isError, `${JSON.stringify(at)}`];
  },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("mouse_move", { x: 1, y: 1 }); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.click_turnstile = {
  // A dummy token on a Cloudflare test sitekey on a page still titled "Just a moment..."
  // is not a pass, and the reply has to show that.
  ok: async () => {
    await home("/ts-pass");
    const pass = await c("click_turnstile", { wait_render_ms: 0, offset_x: 30, max_attempts: 1 });
    await home("/ts-dummy");
    const dummy = await c("click_turnstile", { wait_render_ms: 0, offset_x: 30, max_attempts: 1 });
    const honest = /just a moment/i.test(dummy.text) && /test sitekey|1x|dummy/i.test(dummy.text) && !/SOLVED/.test(dummy.text);
    return [/token/i.test(pass.text) && !pass.isError && !/SOLVED/.test(pass.text) && honest, `${short(pass.text)} || ${short(dummy.text)}`];
  },
  fail: async () => {
    await home("/ts-never");
    const a = await c("click_turnstile", { wait_render_ms: 0, max_attempts: 1 });
    await home("/short");
    const b = await c("click_turnstile", { wait_render_ms: 0, max_attempts: 1 });
    return [a.isError && b.isError, `${a.isError},${b.isError} ${short(a.text)} || ${short(b.text)}`];
  },
};
T.drag_and_drop = {
  ok: async () => {
    await home();
    await ev("document.getElementById('drag').setAttribute('data-mcp-ref','dr');document.getElementById('drop').setAttribute('data-mcp-ref','dp');document.getElementById('drag').scrollIntoView();1");
    const r = await c("drag_and_drop", { source_ref: "dr", target_ref: "dp" });
    const m = await marks();
    return [m.includes("drop") && !r.isError, `${JSON.stringify(m)} ${short(r.text)}`];
  },
  fail: async () => { const r = await c("drag_and_drop", { source_ref: "e99998", target_ref: "e99999" }); return [r.isError, short(r.text)]; },
};
T.list_frames = {
  ok: async () => { await home(); const r = await c("list_frames"); return [/Frames \(2\)/.test(r.text) && r.text.includes("/frame"), short(r.text)]; },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("list_frames"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.frame_evaluate = {
  ok: async () => {
    const r = await c("frame_evaluate", { frame_name: "fr", expression: "document.getElementById('fd').textContent" });
    return [r.text === "frame-data", r.text];
  },
  fail: async () => {
    const a = await c("frame_evaluate", { frame_name: "tidak-ada", expression: "1" });
    const b = await c("frame_evaluate", { frame_name: "fr", expression: "(function(){throw new Error('x')})()" });
    return [a.isError && b.isError, `${a.isError},${b.isError}`];
  },
};
T.wait_for_url = {
  ok: async () => {
    await home();
    await ev("setTimeout(function(){location.href='/second?u=1'},200);1");
    const r = await c("wait_for_url", { pattern: "/second", timeout: 5000 });
    return [!r.isError, `${r.seconds}s ${short(r.text)}`];
  },
  fail: async () => { const r = await c("wait_for_url", { pattern: "tidak-ada", timeout: 300 }); return [r.isError, short(r.text)]; },
};
T.wait_for_response = {
  ok: async () => {
    await ev("setTimeout(function () { fetch('/slow'); }, 300);1");
    const r = await c("wait_for_response", { url_pattern: "/slow", timeout: 5000 });
    return [/200/.test(r.text) && !r.isError, short(r.text)];
  },
  fail: async () => { const r = await c("wait_for_response", { url_pattern: "tidak-ada", timeout: 300 }); return [r.isError, short(r.text)]; },
};
T.wait_for_request = {
  ok: async () => {
    await home("/calls");
    await ev("setTimeout(fire, 150);1");
    const r = await c("wait_for_request", { url_pattern: "api.json", method: "POST", timeout: 5000 });
    return [r.text.includes("POST") && !leaked(r.text).length && !r.isError, short(r.text)];
  },
  fail: async () => { const r = await c("wait_for_request", { url_pattern: "tidak-ada", timeout: 300 }); return [r.isError, short(r.text)]; },
};
T.get_viewport_size = {
  ok: async () => {
    const r = await c("get_viewport_size");
    const v = await evj("[innerWidth, innerHeight]");
    return [r.text.includes(`${v[0]}x${v[1]}`), `${r.text} page=${v}`];
  },
  fail: async () => {
    const s = await connect();
    try {
      await s.call("browser_launch", { ...LOCAL_LAUNCH, no_viewport: true });
      const r = await s.call("get_viewport_size");
      return [/\d+x\d+/.test(r.text), short(r.text)];
    } finally { await s.close(); }
  },
};
T.set_viewport_size = {
  ok: async () => {
    const r = await c("set_viewport_size", { width: 900, height: 600 });
    const v = await evj("[innerWidth, innerHeight]");
    await c("set_viewport_size", { width: 1280, height: 720 });
    return [v[0] === 900 && v[1] === 600 && r.text.includes("900x600"), `${v} ${short(r.text)}`];
  },
  // On its own server: before the size was validated this call hung for the whole
  // client timeout and left the page with no usable viewport, and every later click
  // in a shared session then fell back to synthetic events.
  fail: async () => {
    const s = await connect();
    try {
      await s.call("browser_launch", LOCAL_LAUNCH);
      const r = await s.call("set_viewport_size", { width: -5, height: 0 }, { timeoutMs: 15000 });
      return [r.isError && r.seconds < 5, `${r.seconds}s ${short(r.text)}`];
    } catch (e) { return [false, "THREW " + short(e.message)]; } finally { await s.close(); }
  },
};
T.accessibility_snapshot = {
  ok: async () => { const r = await c("accessibility_snapshot"); return [r.text.includes("Audit Fixture") && !leaked(r.text).length, `chars=${r.text.length}`]; },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("accessibility_snapshot"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.server_status = {
  // The profile reported has to be the one the browser is really using.
  ok: async () => {
    const st = JSON.parse((await c("server_status")).text);
    const actual = (M.browsers()[0]?.command.match(/-profile\s+(\S+)/) || [])[1];
    return [st.profile_dir === actual && st.active_tabs === 1, `reported=${st.profile_dir} actual=${actual}`];
  },
  fail: async () => {
    const s = await connect();
    try {
      const st = JSON.parse((await s.call("server_status")).text);
      return [st.browser_up === false && st.active_tabs === 0, short(JSON.stringify(st))];
    } finally { await s.close(); }
  },
};
T.get_page_errors = {
  ok: async () => {
    await home();
    await ev("setTimeout(function(){throw new Error('sengaja-gagal')},0);1");
    const got = await until(async () => (await c("get_page_errors")).text.includes("sengaja-gagal"), 3000);
    return [got, String(got)];
  },
  fail: async () => {
    await home();
    const r = await c("get_page_errors");
    return [/No JS errors/.test(r.text), short(r.text)];
  },
};
T.inject_init_script = {
  ok: async () => {
    const r = await c("inject_init_script", { script: "window.__inj = 7;" });
    await c("reload");
    return [(await ev("window.__inj")) === "7" && !r.isError, short(r.text)];
  },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("inject_init_script", { script: "1" }); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.export_har = {
  ok: async () => {
    await home("/calls");
    await c("network_start", { capture_bodies: true });
    await ev("fire()");
    await until(async () => (await c("network_get", { filter: "api.json" })).text.includes("api.json"), 3000);
    const p = join(work, "x.har");
    const r = await c("export_har", { path: p });
    const raw = readFileSync(p, "utf8"), har = JSON.parse(raw).log;
    const e = har.entries.find(x => x.request.url.includes("api.json"));
    const mode = (statSync(p).mode & 0o777).toString(8);
    const valid = har.version === "1.2" && e && Array.isArray(e.request.headers) && e.timings.send >= 0 && e.timings.wait >= 0 && e.timings.receive >= 0;
    const qs = e?.request.queryString?.some(q => q.name === "keep");
    return [valid && qs && mode === "600" && !leaked(raw).length, `mode=${mode} valid=${valid} queryString=${qs} leaked=${leaked(raw).length} ${short(r.text)}`];
  },
  fail: async () => {
    const s = await connect();
    try {
      await s.call("browser_launch", LOCAL_LAUNCH);
      const r = await s.call("export_har", { path: join(work, "kosong.har") });
      return [r.isError, short(r.text)];
    } finally { await s.close(); }
  },
};
T.fingerprint_audit = {
  ok: async () => { const r = await c("fingerprint_audit"); return [r.text.includes("user-agent") && !r.isError, short(r.text.split("\n").slice(-4).join(" "))]; },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("fingerprint_audit"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.detect_content_pattern = {
  ok: async () => { await home(); const r = await c("detect_content_pattern", { min_items: 3 }); return [r.text.includes("li.card"), short(r.text)]; },
  fail: async () => {
    await home("/short");
    const r = await c("detect_content_pattern", { min_items: 3 });
    return [/No repeated/.test(r.text), short(r.text)];
  },
};
T.extract_structured = {
  ok: async () => {
    await home();
    const r = await c("extract_structured", { container_selector: "li.card", fields: [{ name: "t", selector: "h3" }, { name: "h", selector: "a", attribute: "href" }] });
    const d = JSON.parse(r.text);
    return [d.items.length === 4 && d.items[0].t === "Card 1" && d.items[0].h === "/c1", short(r.text)];
  },
  fail: async () => { const r = await c("extract_structured", { container_selector: "[[[", fields: [] }); return [r.isError, short(r.text)]; },
};
T.extract_table = {
  ok: async () => {
    const r = await c("extract_table", { selector: "#tbl" });
    const d = JSON.parse(r.text);
    return [d.rows.length === 2 && d.rows[1].Name === "Banana", short(r.text)];
  },
  fail: async () => { const r = await c("extract_table", { selector: "#tidak-ada" }); return [r.isError, short(r.text)]; },
};
T.scrape_page = {
  ok: async () => { await home("/article"); const r = await c("scrape_page"); return [JSON.parse(r.text).title === "Artikel", short(r.text)]; },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("scrape_page"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.wait_and_snapshot = {
  ok: async () => { await home(); const r = await c("wait_and_snapshot", { selector: "#noop" }); return [r.text.includes("NoOp"), `chars=${r.text.length}`]; },
  fail: async () => { const r = await c("wait_and_snapshot", { selector: "#tidak", timeout: 300 }); return [r.isError, short(r.text)]; },
};
T.back_and_snapshot = {
  ok: async () => {
    await home(); await c("navigate", { url: fx.url + "/second" });
    const r = await c("back_and_snapshot");
    return [r.text.includes("NoOp"), `chars=${r.text.length}`];
  },
  fail: async () => {
    await c("tab_new", { url: fx.url + "/second" });
    const r = await c("back_and_snapshot");
    return [r.isError || /no (previous|history|page)|nothing/i.test(r.text), short(r.text)];
  },
};
T.reload_and_snapshot = {
  ok: async () => { await home(); const r = await c("reload_and_snapshot"); return [r.text.includes("NoOp"), `chars=${r.text.length}`]; },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("reload_and_snapshot"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.click_and_snapshot = {
  ok: async () => {
    await home();
    const r = await c("click_and_snapshot", { ref: await ref("Count: 0"), wait_ms: 50 });
    return [r.text.includes("Count: 1"), short(r.text.slice(0, 120))];
  },
  fail: async () => { const r = await c("click_and_snapshot", { ref: "e99999", wait_ms: 10 }); return [r.isError, short(r.text)]; },
};
T.find_by_text = {
  ok: async () => { const r = await c("find_by_text", { text: "NoOp" }); return [/1 match/.test(r.text) && /ref=/.test(r.text), short(r.text)]; },
  fail: async () => { const r = await c("find_by_text", { text: "tidak-ada-teks" }); return [/No element/.test(r.text), short(r.text)]; },
};
T.find_by_label = {
  ok: async () => {
    const r = await c("find_by_label", { label: "Full Name" });
    const single = await c("find_by_label", { label: "Sandi" });
    const many = await c("find_by_label", { label: "Rahasia" });
    return [r.text.includes('"name": "fullname"') && !leaked(single.text).length && !leaked(many.text).length,
      `singleLeak=${leaked(single.text).length} manyLeak=${leaked(many.text).length}`];
  },
  fail: async () => { const r = await c("find_by_label", { label: "tidak-ada" }); return [/No input/.test(r.text), short(r.text)]; },
};
T.find_by_placeholder = {
  ok: async () => { const r = await c("find_by_placeholder", { placeholder: "Your name here" }); return [r.text.includes('"tag": "input"'), short(r.text)]; },
  fail: async () => { const r = await c("find_by_placeholder", { placeholder: "tidak-ada" }); return [/No input/.test(r.text), short(r.text)]; },
};
T.cookie_export = {
  ok: async () => {
    await c("cookie_set", { name: "ekspor", value: SECRET.cookie, domain: host() });
    const r = await c("cookie_export");
    const shown = await c("cookie_export", { reveal_values: true });
    return [r.text.includes("ekspor") && !leaked(r.text).length && shown.text.includes(SECRET.cookie), `leaked=${leaked(r.text).length} revealWorks=${shown.text.includes(SECRET.cookie)}`];
  },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("cookie_export"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.cookie_import = {
  ok: async () => {
    const r = await c("cookie_import", { cookies_json: JSON.stringify([{ name: "impor", value: "v1", domain: host(), path: "/" }]) });
    return [(await ev("document.cookie")).includes("impor=v1") && !r.isError, short(r.text)];
  },
  fail: async () => { const r = await c("cookie_import", { cookies_json: "bukan json" }); return [r.isError, short(r.text)]; },
};
T.page_stats = {
  ok: async () => { await home(); const r = await c("page_stats"); return [JSON.parse(r.text).forms === 1, short(r.text)]; },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("page_stats"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.storage_state_save = {
  ok: async () => {
    await c("cookie_set", { name: "st", value: SECRET.cookie, domain: host(), expires_days: 1 });
    await c("localstorage_set", { key: "lsk", value: "lsv" });
    const p = join(work, "state.json");
    const r = await c("storage_state_save", { path: p });
    const mode = (statSync(p).mode & 0o777).toString(8);
    const d = JSON.parse(readFileSync(p, "utf8"));
    return [mode === "600" && d.cookies.some(x => x.name === "st") && d.origins[0].local.lsk === "lsv" && !leaked(r.text).length, `mode=${mode} ${short(r.text)}`];
  },
  // Cookies are worth saving from a page that has no storage of its own.
  fail: async () => {
    await c("navigate", { url: "about:blank" });
    const p = join(work, "kosong.json");
    const r = await c("storage_state_save", { path: p });
    await home();
    return [!r.isError && existsSync(p), short(r.text)];
  },
};
T.storage_state_load = {
  ok: async () => {
    await c("cookie_delete", { name: "st" });
    await c("localstorage_clear");
    const r = await c("storage_state_load", { path: join(work, "state.json"), navigate_to: fx.url + "/" });
    const ok = (await ev("document.cookie")).includes("st=") && (await ev("localStorage.getItem('lsk')")) === "lsv";
    return [ok && !r.isError, short(r.text)];
  },
  fail: async () => { const r = await c("storage_state_load", { path: join(work, "tidak-ada.json") }); return [r.isError, short(r.text)]; },
};
T.auth_capture = {
  ok: async () => {
    const r = await c("auth_capture", { name: "sesi" });
    const p = join(M.home, ".camoufox-mcp", "sessions", "sesi.json");
    return [existsSync(p) && (statSync(p).mode & 0o777).toString(8) === "600", short(r.text)];
  },
  fail: async () => {
    const r = await c("auth_capture", { name: "../../keluar" });
    return [!existsSync(join(M.home, "keluar.json")), short(r.text)];
  },
};
T.cookie_export_file = {
  ok: async () => {
    const p = join(work, "kuki.json");
    const r = await c("cookie_export_file", { path: p });
    return [(statSync(p).mode & 0o777).toString(8) === "600" && !leaked(r.text).length, short(r.text)];
  },
  fail: async () => {
    const blocker = join(work, "file-biasa");
    writeFileSync(blocker, "x");
    const r = await c("cookie_export_file", { path: join(blocker, "anak", "x.json") });
    return [r.isError, short(r.text)];
  },
};
T.cookie_import_file = {
  ok: async () => {
    await c("cookie_delete", { name: "ekspor" });
    const r = await c("cookie_import_file", { path: join(work, "kuki.json") });
    return [(await ev("document.cookie")).includes("ekspor=") && !r.isError, short(r.text)];
  },
  fail: async () => {
    const p = join(work, "bukan-array.json"); writeFileSync(p, "{}");
    const r = await c("cookie_import_file", { path: p });
    return [r.isError, short(r.text)];
  },
};
T.humanize_click = {
  ok: async () => {
    await home();
    const r = await c("humanize_click", { selector: "#counter" });
    return [(await ev("window.__n")) === "1" && !r.isError, short(r.text)];
  },
  // The overlay takes this click, and the reply must not claim the button got it.
  fail: async () => {
    const r = await c("humanize_click", { selector: "#cov" });
    return [r.isError && /overlay|intercept|cover/i.test(r.text), `marks=${JSON.stringify(await marks())} ${short(r.text)}`];
  },
};
T.humanize_type = {
  ok: async () => {
    const r = await c("humanize_type", { selector: "#ta", text: "abc", mean_delay_ms: 1 });
    return [(await ev("document.getElementById('ta').value")) === "abc" && !r.isError, short(r.text)];
  },
  fail: async () => {
    const r = await c("humanize_type", { ref: "e99999", text: "x", mean_delay_ms: 1 });
    return [r.isError && r.seconds < 15, `${r.seconds}s ${short(r.text)}`];
  },
};
T.mouse_drift = {
  ok: async () => {
    await ev("window.__lastMove=null;1");
    const r = await c("mouse_drift", { duration_ms: 100, points: 2 });
    return [(await evj("window.__lastMove")) !== null && !r.isError, short(r.text)];
  },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("mouse_drift", { duration_ms: 1, points: 1 }); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.mouse_record = {
  ok: async () => {
    await home();
    const r = await c("mouse_record", { duration_ms: 1500 });
    await c("mouse_move", { x: 50, y: 50, steps: 3 });
    await c("mouse_move", { x: 90, y: 70, steps: 3 });
    // The recorder lives in the isolated world, where the page cannot see it.
    const n = (await c("evaluate", { world: "isolated", expression: "window.__mcp_mouse_rec.points.length" })).first;
    return [Number(n) > 0 && !r.isError, `points=${n}`];
  },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("mouse_record", {}); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.mouse_replay = {
  ok: async () => {
    await c("mouse_record", { duration_ms: 1500 });
    await c("mouse_move", { x: 50, y: 50, steps: 3 });
    const r = await c("mouse_replay", { speed: 10 });
    return [/points/.test(r.text) && !/^mouse_replay: 0/.test(r.text) && !r.isError, short(r.text)];
  },
  fail: async () => {
    await home();
    const r = await c("mouse_replay");
    return [r.isError, short(r.text)];
  },
};
T.session_warmup = {
  ok: async () => {
    const r = await c("session_warmup", { duration_ms: 200, sites: [fx.url + "/second"] });
    return [(await ev("location.pathname")) === "/second" && !r.isError, short(r.text)];
  },
  // Every site failed, so "visited 1 sites" would be false.
  fail: async () => {
    const r = await c("session_warmup", { duration_ms: 50, sites: ["http://127.0.0.1:1/"] });
    return [r.isError, short(r.text)];
  },
};
T.detect_anti_bot = {
  ok: async () => {
    await home("/ts-never");
    const r = await c("detect_anti_bot");
    return [JSON.parse(r.text.split("\n\nNote:")[0]).vendors.includes("Cloudflare"), short(r.text)];
  },
  fail: async () => {
    await home("/short");
    const r = await c("detect_anti_bot");
    return [JSON.parse(r.text.split("\n\nNote:")[0]).vendors.length === 0, short(r.text)];
  },
};
T.assert_element_visible = {
  ok: async () => { await home(); const r = await c("assert_element_visible", { selector: "#noop" }); return [r.text.startsWith("PASS") && !r.isError, short(r.text)]; },
  fail: async () => { const r = await c("assert_element_visible", { selector: "#tidak" }); return [r.text.startsWith("FAIL") && r.isError, short(r.text)]; },
};
T.assert_text_present = {
  ok: async () => { const r = await c("assert_text_present", { text: "unik-xyz" }); return [r.text.startsWith("PASS") && !r.isError, short(r.text)]; },
  fail: async () => { const r = await c("assert_text_present", { text: "tidak-ada-teks" }); return [r.text.startsWith("FAIL") && r.isError, short(r.text)]; },
};
T.assert_url_matches = {
  ok: async () => { const r = await c("assert_url_matches", { pattern: "127.0.0.1" }); return [r.text.startsWith("PASS") && !r.isError, short(r.text)]; },
  fail: async () => {
    const a = await c("assert_url_matches", { pattern: "tidak-ada" });
    const b = await c("assert_url_matches", { pattern: "[", regex: true });
    return [a.text.startsWith("FAIL") && a.isError && b.isError, `${a.isError},${b.isError}`];
  },
};
T.assert_clickable = {
  ok: async () => { const r = await c("assert_clickable", { selector: "#noop" }); return [r.text.startsWith("PASS") && !r.isError, short(r.text)]; },
  fail: async () => {
    const a = await c("assert_clickable", { selector: "#cov" });
    return [a.text.startsWith("FAIL") && /overlay/.test(a.text) && a.isError, short(a.text)];
  },
};
T.click_and_wait = {
  ok: async () => {
    await home();
    const r = await c("click_and_wait", { selector: "#nav", wait_for_url: "viaLink" });
    return [(await ev("location.search")) === "?viaLink=1" && !r.isError, short(r.text)];
  },
  // With no wait condition, a click that navigates nowhere is not "domcontentloaded met".
  fail: async () => {
    await home();
    const a = await c("click_and_wait", { selector: "#noop", timeout_ms: 800 });
    const b = await c("click_and_wait", { selector: "#noop", wait_for_selector: "#tidak", timeout_ms: 300 });
    return [(a.isError || /no navigation/i.test(a.text)) && b.isError, `${short(a.text)} || ${short(b.text)}`];
  },
};
T.wait_for_network_idle = {
  ok: async () => {
    await home("/calls-slow");
    const r = await c("wait_for_network_idle", { idle_ms: 200, timeout_ms: 5000 });
    return [/idle/.test(r.text) && !r.isError, short(r.text)];
  },
  fail: async () => {
    await home("/calls-slow");
    await ev("window.__iv = setInterval(function(){ fetch('/slow'); }, 50);1");
    const r = await c("wait_for_network_idle", { idle_ms: 200, timeout_ms: 500 });
    await ev("clearInterval(window.__iv);1");
    return [r.isError, short(r.text)];
  },
};
T.describe_page = {
  ok: async () => {
    await home("/login");
    const r = await c("describe_page");
    return [JSON.parse(r.text).intent === "login_password", short(r.text)];
  },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("describe_page"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.http_request = {
  ok: async () => {
    const r = await c("http_request", { url: fx.url + "/api.json", use_browser_cookies: false });
    const shown = await c("http_request", { url: fx.url + "/api.json", use_browser_cookies: false, reveal_values: true });
    const hop = await c("http_request", { url: fx.url + "/token-redirect", use_browser_cookies: false });
    return [r.text.includes("tampil") && !leaked(r.text).length && !leaked(hop.text).length && shown.text.includes(SECRET.token),
      `body/headerLeak=${leaked(r.text).length} urlLeak=${leaked(hop.text).length} revealWorks=${shown.text.includes(SECRET.token)}`];
  },
  fail: async () => { const r = await c("http_request", { url: "http://127.0.0.1:1/" }); return [r.isError, short(r.text)]; },
};
T.http_session_cookies = {
  ok: async () => {
    await c("cookie_set", { name: "h1", value: SECRET.cookie, domain: host() });
    const r = await c("http_session_cookies", { url: fx.url });
    return [r.text.includes("h1") && !leaked(r.text).length && !leaked(r.text.replace(/…/g, "")).length && !r.text.includes(SECRET.cookie.slice(0, 8)), short(r.text.replace(SECRET.cookie.slice(0, 8), "<BOCOR>"))];
  },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("http_session_cookies", { url: "http://x.test" }); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.search = {
  ok: async () => {
    const r = await c("search", { query: "uji", endpoint: fx.url + "/searx" });
    const none = await c("search", { query: "uji", endpoint: fx.url + "/searx-empty" });
    return [r.text.includes("http://x.test/a") && /No results/.test(none.text), short(r.text)];
  },
  fail: async () => {
    const a = await c("search", { query: "uji" });
    const b = await c("search", { query: "uji", endpoint: fx.url + "/searx-odd" });
    return [a.isError && b.isError, `${short(a.text)} || ${short(b.text)}`];
  },
};
T.scrape_markdown = {
  ok: async () => {
    const r = await c("scrape_markdown", { url: fx.url + "/article" });
    const small = await c("scrape_markdown", { url: fx.url + "/short" });
    return [r.text.includes("# Artikel") && !small.isError && small.text.includes("pendek"), `short page → ${short(small.text)}`];
  },
  fail: async () => {
    const a = await c("scrape_markdown", { url: "http://127.0.0.1:1/" });
    const b = await c("scrape_markdown", { url: fx.url + "/blocked" });
    return [a.isError && b.isError, `${short(a.text)} || ${short(b.text)}`];
  },
};
T.smart_fetch = {
  ok: async () => {
    const r = await c("smart_fetch", { url: fx.url + "/article" });
    const small = await c("smart_fetch", { url: fx.url + "/short" });
    return [r.text.includes("path: http") && small.seconds < 6 && small.text.includes("pendek"), `short page took ${small.seconds}s → ${short(small.text)}`];
  },
  fail: async () => {
    const s = await connect();
    try {
      const r = await s.call("smart_fetch", { url: fx.url + "/blocked" });
      return [r.isError, short(r.text)];
    } finally { await s.close(); }
  },
};
T.search_page = {
  ok: async () => { await home(); const r = await c("search_page", { text: "unik-xyz" }); return [/1 match/.test(r.text), short(r.text)]; },
  fail: async () => { const r = await c("search_page", { text: "[", regex: true }); return [r.isError, short(r.text)]; },
};
T.wait_for_change = {
  ok: async () => {
    await ev("setTimeout(function(){document.title='Berubah'},150);1");
    const r = await c("wait_for_change", { timeout: 3000 });
    return [/Page changed/.test(r.text), short(r.text)];
  },
  fail: async () => { const r = await c("wait_for_change", { timeout: 400 }); return [/No change/.test(r.text), short(r.text)]; },
};
T.scroll_to = {
  ok: async () => {
    await home("/tall");
    const r = await c("scroll_to", { selector: "#end" });
    const inView = await evj("(function(){var r=document.getElementById('end').getBoundingClientRect();return r.top>=0&&r.top<innerHeight})()");
    return [inView && !r.isError, short(r.text)];
  },
  fail: async () => { const r = await c("scroll_to", { selector: "#tidak" }); return [r.isError, short(r.text)]; },
};
T.click_element_offset = {
  ok: async () => {
    await home();
    await ev("document.getElementById('wide').scrollIntoView();1");
    const r = await c("click_element_offset", { selector: "#wide", x_percent: 10, y_percent: 50 });
    return [(await marks()).some(m => /^wide@20,/.test(m)), `${JSON.stringify(await marks())} ${short(r.text)}`];
  },
  fail: async () => {
    await home();
    const r = await c("click_element_offset", { selector: "#cov" });
    return [r.isError && /overlay|intercept|cover/i.test(r.text), `marks=${JSON.stringify(await marks())} ${short(r.text)}`];
  },
};
T.click_at_corner = {
  ok: async () => {
    await home();
    await ev("document.getElementById('wide').scrollIntoView();1");
    const r = await c("click_at_corner", { selector: "#wide", corner: "top-left", offset: 5 });
    return [(await marks()).some(m => /^wide@5,[45]$/.test(m)), `${JSON.stringify(await marks())} ${short(r.text)}`];
  },
  fail: async () => {
    await home();
    const r = await c("click_at_corner", { selector: "#cov" });
    return [r.isError && /overlay|intercept|cover/i.test(r.text), `marks=${JSON.stringify(await marks())} ${short(r.text)}`];
  },
};
T.paste_text = {
  ok: async () => {
    await home();
    const r = await c("paste_text", { selector: "#ta", text: "tempel" });
    return [(await ev("document.getElementById('ta').value")) === "tempel" && !r.isError, short(r.text)];
  },
  fail: async () => { const r = await c("paste_text", { selector: "#tidak", text: "x" }); return [r.isError, short(r.text)]; },
};
T.form_introspect = {
  ok: async () => {
    await home();
    const r = await c("form_introspect", { form_selector: "#f1" });
    const d = JSON.parse(r.text);
    return [d.form_found && d.fields.some(f => f.name === "nick") && !leaked(r.text).length, `fields=${d.field_count} leaked=${leaked(r.text).length}`];
  },
  fail: async () => {
    const r = await c("form_introspect", { form_selector: "#tidak-ada" });
    return [r.isError || JSON.parse(r.text).form_found === false, short(r.text)];
  },
};
T.smart_fill = {
  ok: async () => {
    await home();
    const r = await c("smart_fill", { fields_json: JSON.stringify({ "Full Name": "Budi", Sandi: SECRET.password }) });
    const v = await evj("[document.getElementById('lab').value, document.getElementById('pw').value]");
    return [v[0] === "Budi" && v[1] === SECRET.password && !leaked(r.text).length && !r.isError, short(r.text)];
  },
  fail: async () => {
    await home();
    await ev("document.getElementById('pw').disabled = true;1");
    const a = await c("smart_fill", { fields_json: JSON.stringify({ "Tidak Ada": "x" }) });
    const b = await c("smart_fill", { fields_json: JSON.stringify({ Sandi: SECRET.password }) });
    const kept = await ev("document.getElementById('pw').value");
    return [a.isError && b.isError && !leaked(b.text).length && kept === SECRET.password, `kept=${kept === SECRET.password} leak=${leaked(b.text).length} ${short(a.text)}`];
  },
};
T.storage_snapshot = {
  ok: async () => {
    await home();
    const r = await c("storage_snapshot", { name: "awal" });
    return [/Snapshot "awal"/.test(r.text), short(r.text)];
  },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("storage_snapshot"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.storage_diff = {
  ok: async () => {
    await c("cookie_set", { name: "baru", value: SECRET.cookie, domain: host() });
    await c("localstorage_set", { key: "api_token", value: SECRET.token });
    const r = await c("storage_diff", { name: "awal" });
    const shown = await c("storage_diff", { name: "awal", reveal_values: true });
    await c("cookie_delete", { name: "baru" });
    await c("localstorage_clear");
    return [r.text.includes("api_token") && r.text.includes("baru") && !leaked(r.text).length && shown.text.includes(SECRET.token), `leaked=${leaked(r.text).length}`];
  },
  fail: async () => { const r = await c("storage_diff", { name: "tidak-ada" }); return [r.isError, short(r.text)]; },
};
T.indexeddb_list = {
  ok: async () => {
    await ev("new Promise(function(res){var q=indexedDB.open('dbuji',1);q.onsuccess=function(){q.result.close();res(1)};q.onerror=function(){res(0)}})");
    const r = await c("indexeddb_list");
    return [r.text.includes("dbuji"), short(r.text)];
  },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("indexeddb_list"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.indexeddb_delete = {
  ok: async () => {
    const r = await c("indexeddb_delete", { name: "dbuji" });
    const after = await c("indexeddb_list");
    return [!r.isError && !after.text.includes("dbuji"), short(r.text)];
  },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("indexeddb_delete", { name: "x" }); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.performance_timeline = {
  ok: async () => {
    await home();
    const r = await c("performance_timeline");
    const d = JSON.parse(r.text);
    return [d.load_ms >= 0 && d.resource_count >= 1, short(r.text)];
  },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("performance_timeline"); return [r.isError, short(r.text)]; } finally { await s.close(); }
  },
};
T.browser_recover = {
  ok: async () => {
    const s = await connect();
    try {
      await s.call("browser_launch", LOCAL_LAUNCH);
      const r = await s.call("browser_recover");
      const gone = await until(() => s.browsers().length === 0, 8000);
      const again = await s.call("browser_launch", LOCAL_LAUNCH);
      return [gone && /launched/i.test(again.text) && s.browsers().length === 1, `gone=${gone} ${short(r.text)}`];
    } finally { await s.close(); }
  },
  fail: async () => {
    const s = await connect();
    try { const r = await s.call("browser_recover"); return [!r.isError && /no context/.test(r.text), short(r.text)]; } finally { await s.close(); }
  },
};
T.workflow_run = {
  ok: async () => {
    await home();
    const r = await c("workflow_run", { steps: [{ tool: "evaluate", args: { expression: "window.__n = 5; 1" } }, { tool: "get_url" }] });
    return [(await ev("window.__n")) === "5" && !r.isError, short(r.text)];
  },
  // A failed assertion inside a workflow has to count as a failed step.
  fail: async () => {
    const a = await c("workflow_run", { steps: [{ tool: "tidak_ada" }] });
    const b = await c("workflow_run", { steps: [{ tool: "assert_text_present", args: { text: "tidak-ada-teks" } }, { tool: "get_url" }] });
    return [a.isError && b.isError && /ran|1 failed/.test(b.text), `${a.isError},${b.isError} ${short(b.text)}`];
  },
};

// ── Findings that cut across tools ──────────────────────────────────────────
const H = [];
const hyp = (id, name, fn) => H.push({ id, name, fn });

hyp("H2", "No tool declares an output schema a reply could violate; every inputSchema compiles", async () => {
  const { tools } = await M.client.listTools();
  const ajv = new Ajv({ strict: false });
  const bad = [];
  for (const t of tools) { try { ajv.compile(t.inputSchema); } catch (e) { bad.push(`${t.name}: ${e.message}`); } }
  return [bad.length === 0 && tools.every(t => !t.outputSchema), `outputSchema=${tools.filter(t => t.outputSchema).length} badInput=${bad.length} ${short(bad.join("; "))}`];
});
hyp("H3", "String parameters holding JSON-looking text stay strings", async () => {
  await home();
  const out = [];
  for (const v of ['{"a":1}', "[1]", "null", "true", "123"]) {
    const r = await c("http_request", { url: fx.url + "/echo", method: "POST", body: v, use_browser_cookies: false });
    const sent = JSON.parse(r.text.split("── body ──\n")[1]).body;
    await ev("document.getElementById('txt').setAttribute('data-mcp-ref','j1');1");
    const f = await c("fill", { ref: "j1", value: v });
    const got = await ev("document.getElementById('txt').value");
    out.push(sent === v && got === v && !f.isError);
  }
  return [out.every(Boolean), out.join(",")];
});
hyp("H4a", "A click with no effect says so", async () => {
  await home();
  const r = await c("click", { ref: await ref("NoOp") });
  return [/no (visible |page )?change/i.test(r.text), short(r.text)];
});
hyp("H4b", "Counter going 0 to 1 (same text length) reads as a change", async () => {
  await home();
  const r = await c("click", { ref: await ref("Count: 0") });
  return [!/no (visible |page )?change/i.test(r.text) && /chang/i.test(r.text), short(r.text)];
});
hyp("H4c", "Click on a covered element names the blocker and is not reported clean", async () => {
  await home();
  const covRef = await ref("CoveredBtn");
  const r = await c("click", { ref: covRef });
  return [/id="overlay"/.test(r.text) && /⚠/.test(r.text), `marks=${JSON.stringify(await marks())} isError=${r.isError} ${short(r.text)}`];
});
hyp("H4d", "Click on a disabled element is an error", async () => {
  await home();
  const r = await c("click", { ref: await ref("DisabledBtn") });
  return [r.isError && /disabled/i.test(r.text) && !(await marks()).includes("dis"), `isError=${r.isError} ${short(r.text)}`];
});
hyp("H4e", "Click on an element hidden after the snapshot is an error and fires nothing", async () => {
  await home();
  const hidRef = await ref("HideMe");
  await ev("document.getElementById('hid').style.display='none';1");
  const r = await c("click", { ref: hidRef });
  return [r.isError && /hidden|not visible/i.test(r.text) && !(await marks()).includes("hid"), `isError=${r.isError} marks=${JSON.stringify(await marks())} ${short(r.text)}`];
});
hyp("H4f", "A click that opens a tab reports the tab", async () => {
  await home();
  const r = await c("click", { ref: await ref("PopupBtn") });
  return [/new tab|opened/i.test(r.text) && r.text.includes("/second"), short(r.text)];
});
hyp("H4g", "Focus falling to body after a click is not reported as a reaction", async () => {
  await home();
  await ev("document.getElementById('txt').focus();1");
  const r = await c("click", { ref: await ref("NoOp") });
  return [/no (visible |page )?change/i.test(r.text), short(r.text)];
});
hyp("H4h", "A blocked right-click is not turned into a left-click", async () => {
  await home();
  const rc = await ref("CoveredMenu");
  const r = await c("click", { ref: rc, button: "right" });
  const m = await marks();
  return [!m.includes("rcov-leftclick") && r.isError, `marks=${JSON.stringify(m)} isError=${r.isError} ${short(r.text)}`];
});
hyp("H4i", "A real right-click fires contextmenu, not click", async () => {
  await home();
  const r = await c("click", { ref: await ref("RightClickMe"), button: "right" });
  const m = await marks();
  return [m.includes("contextmenu") && !m.includes("leftclick"), `marks=${JSON.stringify(m)} ${short(r.text)}`];
});
hyp("H5", "evaluate: thrown error and rejected promise are errors", async () => {
  const a = await c("evaluate", { expression: "(function(){throw new Error('x')})()" });
  const b = await c("evaluate", { expression: "Promise.reject(new Error('y'))" });
  return [a.isError && b.isError, `${a.isError},${b.isError}`];
});
hyp("H6a", "alert does not hang click, and the reply names it", async () => {
  await home();
  const r = await c("click", { ref: await ref("AlertBtn") }, { timeoutMs: 20000 });
  return [(await marks()).includes("alert-returned") && r.seconds < 8 && /halo-alert|dialog/i.test(r.text), `${r.seconds}s ${short(r.text)}`];
});
hyp("H6b", "A dialog auto-dismissed with no handler is reported, not silently dropped", async () => {
  await home();
  const r = await c("click", { ref: await ref("ConfirmBtn") });
  return [/yakin|dialog/i.test(r.text) && /dismiss/i.test(r.text), `marks=${JSON.stringify(await marks())} ${short(r.text)}`];
});
hyp("H6c", "A dialog raised by mousemove before the press does not hang", async () => {
  await home();
  const r = await c("humanize_click", { selector: "#moved" }, { timeoutMs: 25000 });
  return [r.seconds < 10 && (await marks()).includes("move-dialog"), `${r.seconds}s marks=${JSON.stringify(await marks())} ${short(r.text)}`];
});
hyp("H6d", "A dialog raised inside evaluate does not hang", async () => {
  await home();
  const r = await c("evaluate", { expression: "alert('dari-evaluate'); 'selesai'" }, { timeoutMs: 20000 });
  return [r.text.startsWith("selesai") && /dari-evaluate/.test(r.text) && r.seconds < 8, `${r.seconds}s ${short(r.text)}`];
});
// A dialog cannot be held open on this stack: every one is answered as it arrives. The
// honest behaviour is to say one already went by and to apply to the next.
hyp("H6e", "dialog_handle armed too late says the dialog already went by, and then answers the next", async () => {
  await home();
  await ev("setTimeout(function(){ mark('prompt=' + prompt('tertahan?', '')); }, 20);1");
  await until(async () => (await marks()).some(v => v.startsWith("prompt=")), 3000);
  const r = await c("dialog_handle", { action: "accept", prompt_text: "jawab" });
  await c("click_text", { text: "PromptBtn" });
  const m = await marks();
  return [/tertahan/.test(r.text) && m.includes("prompt=jawab"), `marks=${JSON.stringify(m)} ${short(r.text)}`];
});
hyp("H7a", "fill_form: partial failure is an error and does not submit", async () => T.fill_form.fail());
hyp("H7b", "batch_actions counts failures and stops before the next action", async () => T.batch_actions.fail());
hyp("H7c", "fill keeps newlines in a textarea", async () => T.fill.ok());
hyp("H8a", "cookie_delete without domain really removes the cookie", async () => T.cookie_delete.ok());
hyp("H8b", "cookie_delete by domain: exact-host match, not substring", async () => {
  await c("cookie_set", { name: "d1", value: "1", domain: host() });
  await c("cookie_set", { name: "d2", value: "2", domain: "not" + "127.0.0.1" + ".test" });
  const r = await c("cookie_delete", { domain: "127.0.0.1" });
  const left = await c("cookie_export", { reveal_values: false });
  const has = n => left.text.includes(`"name": "${n}"`);
  return [!has("d1") && has("d2"), `d1=${has("d1")} d2=${has("d2")} ${short(r.text)}`];
});
hyp("H8c", "cookie_delete keeps the others intact, including session and httpOnly", async () => {
  await home();
  await c("cookie_set", { name: "keep_http", value: "v1", domain: host(), http_only: true, expires_days: 3 });
  await c("cookie_set", { name: "keep_ses", value: "v2", domain: host() });
  await c("cookie_set", { name: "drop_me", value: "v3", domain: host() });
  const before = JSON.parse((await c("cookie_export", { reveal_values: true })).text);
  await c("cookie_delete", { name: "drop_me" });
  const after = JSON.parse((await c("cookie_export", { reveal_values: true })).text);
  const http = after.find(x => x.name === "keep_http"), ses = after.find(x => x.name === "keep_ses");
  const orig = before.find(x => x.name === "keep_http");
  return [!after.some(x => x.name === "drop_me") && http?.httpOnly === true && Math.abs(http.expires - orig.expires) < 2 && ses?.value === "v2", short(JSON.stringify(after.map(x => x.name)))];
});
hyp("H9a", "server_status reports the profile actually in use", async () => T.server_status.ok());
hyp("H9b", "After the browser dies, status is honest and a relaunch works", async () => {
  const s = await connect();
  try {
    await s.call("browser_launch", LOCAL_LAUNCH);
    const b = s.browsers()[0];
    process.kill(b.pid, "SIGKILL");
    await until(() => !isAlive(b.pid), 5000);
    await new Promise(r => setTimeout(r, 500));
    const st = JSON.parse((await s.call("server_status")).text);
    const nav = await s.call("navigate", { url: fx.url });
    const again = await s.call("browser_launch", { ...LOCAL_LAUNCH, url: fx.url });
    const here = await s.call("evaluate", { expression: "location.pathname" });
    return [st.browser_up === false && /launched/i.test(again.text) && here.text === "/" && s.browsers().length === 1,
      `status=${st.browser_up}/${st.active_tabs} nav=${short(nav.text)} relaunch=${short(again.text)}`];
  } finally { await s.close(); }
});
hyp("H9c", "Tabs opened and closed by the site keep the count right", async () => {
  await home();
  await c("click", { ref: await ref("PopupBtn") });
  const open = JSON.parse((await c("server_status")).text).active_tabs;
  await c("tab_close", { index: 1 });
  const closed = JSON.parse((await c("server_status")).text).active_tabs;
  return [open === 2 && closed === 1, `${open} -> ${closed}`];
});
hyp("H10a", "set_viewport_size reports the size the page really has", async () => T.set_viewport_size.ok());
hyp("H10b", "export_har: valid HAR 1.2, mode 600, no credentials by default", async () => T.export_har.ok());
hyp("H11", "click_turnstile reports what it observed, a dummy token is not a pass", async () => T.click_turnstile.ok());
hyp("H12a", "Credentials stay out of the network tools", async () => {
  await home("/calls");
  await c("network_start", { capture_bodies: true });
  await ev("fire()");
  await until(async () => (await c("network_get", { filter: "api.json" })).text.includes("api.json"), 3000);
  const texts = {
    network_get: (await c("network_get")).text,
    detail: (await c("network_get_detail", { url: "api.json" })).text,
    curl: (await c("export_curl", { url_contains: "api.json" })).text,
  };
  const bad = Object.entries(texts).filter(([, t]) => leaked(t).length).map(([k, t]) => `${k}:${leaked(t).length}`);
  return [bad.length === 0, bad.join(" ") || "clean"];
});
hyp("H12b", "A password never appears in a form or field reply", async () => {
  await home();
  const texts = {
    form_introspect: (await c("form_introspect", { form_selector: "#f1" })).text,
    find_by_label: (await c("find_by_label", { label: "Sandi" })).text,
    find_by_label_many: (await c("find_by_label", { label: "Rahasia" })).text,
    snapshot: await snap(),
  };
  await ev("document.getElementById('pw').focus();1");
  const t = await c("type_text", { text: SECRET.password, delay: 0 });
  texts.type_text = t.text;
  const bad = Object.entries(texts).filter(([, x]) => leaked(x).length).map(([k]) => k);
  return [bad.length === 0, bad.join(" ") || "clean"];
});
hyp("H12c", "A failed fill on a password field does not echo the value", async () => {
  await home();
  await ev("var p=document.getElementById('pw');p.disabled=true;p.setAttribute('data-mcp-ref','p9');1");
  const r = await c("fill", { ref: "p9", value: SECRET.password });
  return [r.isError && !leaked(r.text).length, `isError=${r.isError} leaked=${leaked(r.text).length}`];
});
hyp("H13a", "browser_close leaves no process and no temp profile", async () => T.browser_close.ok());
hyp("H13b", "A launch against a locked profile fails cleanly and leaves nothing", async () => {
  const a = await connect();
  const b = await connect({ home: a.home });
  try {
    await a.call("browser_launch", { headless: true, geoip: false });
    const r = await b.call("browser_launch", { headless: true, geoip: false }, { timeoutMs: 90000 });
    const leftover = b.browsers().length;
    const st = JSON.parse((await b.call("server_status")).text);
    return [r.isError && leftover === 0 && st.browser_up === false, `isError=${r.isError} leftover=${leftover} up=${st.browser_up} ${r.seconds}s ${short(r.text)}`];
  } finally { await b.close(); await a.close(); rmSync(a.home, { recursive: true, force: true }); }
});
hyp("H13c", "After the last tab is closed, browser_launch works and leaves one browser", async () => {
  const s = await connect();
  try {
    await s.call("browser_launch", LOCAL_LAUNCH);
    const old = s.browsers().map(p => p.pid);
    const closed = await s.call("tab_close", { index: 0 });
    const again = await s.call("browser_launch", { ...LOCAL_LAUNCH, url: fx.url + "/second" });
    const here = await s.call("evaluate", { expression: "location.pathname" });
    const now = s.browsers();
    return [!again.isError && here.text === "/second" && now.length === 1, `old=${old} now=${now.map(p => p.pid)} closed=${short(closed.text)} again=${short(again.text)}`];
  } finally { await s.close(); }
});
hyp("H13d", "A launch whose first navigation fails still reports the running browser", async () => {
  const s = await connect();
  try {
    const r = await s.call("browser_launch", { ...LOCAL_LAUNCH, url: "http://127.0.0.1:1/" });
    const n = s.browsers().length;
    const st = JSON.parse((await s.call("server_status")).text);
    const stated = /browser (is )?(still )?running|browser_close/i.test(r.text);
    return [r.isError && ((n === 0 && !st.browser_up) || (n === 1 && st.browser_up && stated)), `browsers=${n} up=${st.browser_up} stated=${stated} ${short(r.text)}`];
  } finally { await s.close(); }
});
hyp("H13e", "When the client vanishes, server and browser exit and the temp profile goes", async () => {
  const s = await connect({ keepHome: true });
  await s.call("browser_launch", LOCAL_LAUNCH);
  const pids = [s.pid, ...s.browsers().map(p => p.pid)];
  s.transport._process.stdin.end();   // what a crashed client looks like from the server
  const gone = await until(() => pids.every(p => !isAlive(p)), 10000, 200);
  const temp = readdirSync(join(s.home, ".camoufox-mcp")).filter(n => n.startsWith("profile-fresh-"));
  const alive = pids.filter(isAlive);
  // Clean up only what this test started.
  for (const p of alive) { try { process.kill(p, "SIGKILL"); } catch {} }
  try { await s.client.close(); } catch {}
  rmSync(s.home, { recursive: true, force: true });
  return [gone && temp.length === 0, `stillAlive=${alive.length} tempLeft=${temp.length}`];
});
hyp("H13f", "SIGTERM on the server removes the temp profile too", async () => {
  const s = await connect({ keepHome: true });
  await s.call("browser_launch", LOCAL_LAUNCH);
  const pids = [s.pid, ...s.browsers().map(p => p.pid)];
  process.kill(s.pid, "SIGTERM");
  const gone = await until(() => pids.every(p => !isAlive(p)), 10000, 200);
  const temp = readdirSync(join(s.home, ".camoufox-mcp")).filter(n => n.startsWith("profile-fresh-"));
  for (const p of pids.filter(isAlive)) { try { process.kill(p, "SIGKILL"); } catch {} }
  try { await s.client.close(); } catch {}
  rmSync(s.home, { recursive: true, force: true });
  return [gone && temp.length === 0, `gone=${gone} tempLeft=${temp.length}`];
});
hyp("H13g", "Temp profiles left by a crashed server are removed by the next launch", async () => {
  const s = await connect({ keepHome: true });
  await s.call("browser_launch", LOCAL_LAUNCH);
  const pids = [s.pid, ...s.browsers().map(p => p.pid)];
  process.kill(s.pid, "SIGKILL");
  for (const b of pids.slice(1)) { try { process.kill(b, "SIGKILL"); } catch {} }
  await until(() => pids.every(p => !isAlive(p)), 8000, 200);
  try { await s.client.close(); } catch {}
  const s2 = await connect({ home: s.home });
  try {
    await s2.call("browser_launch", LOCAL_LAUNCH);
    const live = (s2.browsers()[0]?.command.match(/-profile\s+(\S+)/) || [])[1];
    const temp = readdirSync(join(s.home, ".camoufox-mcp")).filter(n => n.startsWith("profile-fresh-"));
    const stale = temp.filter(n => join(s.home, ".camoufox-mcp", n) !== live);
    return [stale.length === 0, `stale=${stale.length} of ${temp.length}`];
  } finally { await s2.close(); rmSync(s.home, { recursive: true, force: true }); }
});
hyp("H14", "No idle reaper exists that could close a browser someone is using", async () => {
  await new Promise(r => setTimeout(r, 1000));
  const src = readdirSync(new URL("../../src/tools/", import.meta.url)).concat(["../helpers.ts", "../state.ts", "../index.ts"])
    .map(f => readFileSync(new URL(`../../src/tools/${f}`, import.meta.url), "utf8")).join("\n");
  return [!/setInterval\s*\(/.test(src.replace(/`[\s\S]*?`/g, "")) && !/\bidle[_ ]?(reaper|cleanup|timeout)/i.test(src), "no setInterval or idle reaper in server code"];
});
hyp("H16", "Lifecycle events: wait tools still work past the fifth page", async () => {
  const s = await connect();
  try {
    await s.call("browser_launch", LOCAL_LAUNCH);
    for (let i = 0; i < 6; i++) await s.call("tab_new", { url: fx.url + `/second?t=${i}` });
    await s.call("navigate", { url: fx.url });
    await s.call("evaluate", { expression: "setTimeout(function(){location.href='/second?u=9'},150);1" });
    const a = await s.call("wait_for_url", { pattern: "u=9", timeout: 6000 });
    await s.call("navigate", { url: fx.url });
    const b = await s.call("click_and_wait", { selector: "#nav", wait_for_url: "viaLink", timeout_ms: 6000 });
    await s.call("navigate", { url: fx.url });
    await s.call("evaluate", { expression: "setTimeout(function(){location.href='/second?w=9'},150);1" });
    const d = await s.call("wait_for_navigation", { timeout: 6000 });
    return [!a.isError && !b.isError && !d.isError, `url:${a.isError}/${a.seconds}s click_and_wait:${b.isError}/${b.seconds}s nav:${d.isError}/${d.seconds}s ${short(a.text)}`];
  } finally { await s.close(); }
});
hyp("H17", "A slow tool on a missing element fails within a normal action timeout", async () => {
  await home();
  const out = {};
  for (const [name, args] of [
    ["humanize_click", { ref: "e99999" }], ["click_element_offset", { ref: "e99999" }], ["click_at_corner", { ref: "e99999" }],
    ["inspect_element", { ref: "e99999" }], ["get_attribute", { ref: "e99999", attribute: "id" }],
  ]) {
    const r = await c(name, args, { timeoutMs: 45000 });
    out[name] = r.seconds;
    if (!r.isError) out[name] = `no-error ${r.seconds}`;
  }
  return [Object.values(out).every(v => typeof v === "number" && v < 12), JSON.stringify(out)];
});
hyp("H19", "A call that can never finish answers at its deadline instead of hanging", async () => {
  const s = await connect({ env: { MCP_CAMOUFOX_TOOL_DEADLINE_MS: "1500" } });
  try {
    await s.call("browser_launch", LOCAL_LAUNCH);
    const r = await s.call("evaluate", { expression: "new Promise(function () {})" }, { timeoutMs: 15000 });
    const after = await s.call("tab_new", { url: fx.url + "/short" });
    const works = await s.call("evaluate", { expression: "location.pathname" });
    return [r.isError && r.seconds < 6 && /did not finish/.test(r.text) && works.text === "/short" && !after.isError, `${r.seconds}s ${short(r.text)}`];
  } finally { await s.close(); }
});
hyp("H20", "Credential-named storage keys are masked, other keys are not", async () => {
  await home();
  await c("localstorage_set", { key: "access_token", value: SECRET.token });
  await c("localstorage_set", { key: "tema", value: "gelap" });
  const r = await c("localstorage_get");
  const one = await c("localstorage_get", { key: "access_token" });
  const shown = await c("localstorage_get", { key: "access_token", reveal_values: true });
  await c("localstorage_clear");
  return [!leaked(r.text).length && !leaked(one.text).length && r.text.includes("gelap") && shown.text.includes(SECRET.token), short(r.text)];
});
hyp("H21", "A masked cookie export is refused on import rather than overwriting a login", async () => {
  await c("cookie_set", { name: "login", value: SECRET.cookie, domain: host() });
  const exported = await c("cookie_export");
  const r = await c("cookie_import", { cookies_json: exported.text });
  const real = await c("cookie_export", { reveal_values: true });
  return [r.isError && real.text.includes(SECRET.cookie), short(r.text)];
});
hyp("H22", "The pointer can reach the top edge without wedging the tab", async () => {
  await home();
  const a = await c("mouse_move", { x: 60, y: 5 }, { timeoutMs: 15000 });
  const b = await c("mouse_move", { x: 60, y: 0 }, { timeoutMs: 15000 });
  const d = await c("mouse_click_xy", { x: 60, y: 0 }, { timeoutMs: 15000 });
  await ev("document.getElementById('wide').scrollIntoView();1");
  const e = await c("click_at_corner", { selector: "#wide", corner: "top-left", offset: 5 }, { timeoutMs: 15000 });
  const f = await c("click_element_offset", { selector: "#wide", x_percent: 10, y_percent: 50 }, { timeoutMs: 15000 });
  const m = await marks();
  return [!a.isError && !b.isError && !d.isError && !e.isError && !f.isError && b.seconds < 5 && m.some(x => /^wide@/.test(x)), `${b.seconds}s ${d.seconds}s ${e.seconds}s ${f.seconds}s marks=${JSON.stringify(m)}`];
});
hyp("H18", "stdout stays clean JSON-RPC through launch and use", async () => [M.protocolErrors.length === 0, M.protocolErrors.slice(0, 2).join(" | ") || "no protocol errors"]);

// ── Runner ──────────────────────────────────────────────────────────────────
const results = [], hypResults = [];

async function runPath(fn) {
  const started = Date.now();
  try {
    const [ok, detail] = await fn();
    return { ok: !!ok, detail: short(detail), seconds: (Date.now() - started) / 1000 };
  } catch (e) {
    return { ok: false, detail: "THREW " + short(e?.message || e), seconds: (Date.now() - started) / 1000 };
  }
}

/** Every tool that needs a browser must answer with an error, not hang or claim
 *  success, when none is running. Arguments are built from each tool's own schema. */
async function noBrowserPass() {
  const exempt = new Set(["browser_launch", "browser_close", "reset_profile", "browser_recover", "server_status",
    "workflow_run", "http_request", "search", "scrape_markdown", "smart_fetch", "tab_list", "tab_select", "tab_close",
    "console_get", "network_get", "network_get_detail", "export_curl", "intercept_log"]);
  const s = await connect();
  const out = {};
  try {
    const { tools } = await s.client.listTools();
    for (const t of tools) {
      if (exempt.has(t.name)) continue;
      const args = {};
      for (const k of t.inputSchema.required || []) {
        const ty = t.inputSchema.properties[k]?.type;
        args[k] = ty === "number" ? 1 : ty === "array" ? [] : ty === "boolean" ? false : "x";
      }
      const r = await s.call(t.name, args, { timeoutMs: 20000 }).catch(e => ({ isError: false, text: "RPC " + e.message, seconds: 20 }));
      out[t.name] = r.isError && /not running|browser_launch/i.test(r.text);
    }
  } finally { await s.close(); }
  return out;
}

async function main() {
  fx = await auditFixture();
  M = await connect();
  c = M.call;
  const { tools } = await M.client.listTools();
  const names = tools.map(t => t.name).sort();
  const missing = names.filter(n => !T[n]);
  const stale = Object.keys(T).filter(n => !names.includes(n));

  const launched = await c("browser_launch", { ...LOCAL_LAUNCH, url: fx.url });
  if (launched.isError) throw new Error("browser_launch failed: " + launched.text);

  const noBrowser = await noBrowserPass();

  // Order matters: state-building tools run before the tools that read that state,
  // so follow the order the entries were written in.
  for (const name of Object.keys(T)) {
    if (!names.includes(name)) continue;
    const entry = T[name];
    if (entry.skip) { results.push({ name, verdict: "TIDAK DIUJI", detail: entry.skip }); continue; }
    if (!["reset_profile"].includes(name)) { try { await home(); } catch (e) { console.error("home failed before " + name + ": " + e.message); } }
    const ok = await runPath(entry.ok);
    const fail = await runPath(entry.fail);
    const nb = noBrowser[name];
    const bad = !ok.ok || !fail.ok || nb === false;
    results.push({ name, verdict: bad ? "BUG" : "OK", ok, fail, nb });
    console.error(`${bad ? "BUG " : "ok  "} ${name}${!ok.ok ? `\n     sukses: ${ok.detail}` : ""}${!fail.ok ? `\n     gagal : ${fail.detail}` : ""}${nb === false ? "\n     tanpa browser: bukan error yang jelas" : ""}`);
  }
  for (const h of H) {
    try { await home(); } catch {}
    const res = await runPath(h.fn);
    hypResults.push({ ...h, fn: undefined, ...res });
    console.error(`${res.ok ? "ok  " : "BUG "} ${h.id} ${h.name}\n     ${res.detail}`);
  }

  const counts = { OK: 0, BUG: 0, "TIDAK DIUJI": 0 };
  results.forEach(r => counts[r.verdict]++);
  const esc = s => String(s ?? "").replace(/\|/g, "\\|");
  const lines = [
    "# Sapuan semua tool mcp-camoufox lewat klien MCP sungguhan", "",
    `Tool terdaftar: ${names.length}. OK ${counts.OK}, BUG ${counts.BUG}, TIDAK DIUJI ${counts["TIDAK DIUJI"]}. Temuan lintas tool lolos ${hypResults.filter(h => h.ok).length}/${hypResults.length}.`,
    missing.length ? `\nTool TANPA entri sapuan: ${missing.join(", ")}` : "",
    stale.length ? `\nEntri sapuan untuk tool yang sudah tidak ada: ${stale.join(", ")}` : "", "",
    "## Temuan lintas tool", "", "| ID | Pemeriksaan | Hasil | Detail |", "| --- | --- | --- | --- |",
    ...hypResults.map(h => `| ${h.id} | ${esc(h.name)} | ${h.ok ? "OK" : "BUG"} | ${esc(h.detail)} |`), "",
    "## Per tool", "", "| Tool | Hasil | Jalur sukses | Jalur gagal | Tanpa browser |", "| --- | --- | --- | --- | --- |",
    ...results.map(r => r.verdict === "TIDAK DIUJI"
      ? `| \`${r.name}\` | TIDAK DIUJI | ${esc(r.detail)} |  |  |`
      : `| \`${r.name}\` | ${r.verdict} | ${r.ok.ok ? "ok" : "BUG"}: ${esc(r.ok.detail)} | ${r.fail.ok ? "ok" : "BUG"}: ${esc(r.fail.detail)} | ${r.nb === undefined ? "-" : r.nb ? "ok" : "BUG"} |`),
  ];
  if (REPORT) { mkdirSync(dirname(REPORT), { recursive: true }); writeFileSync(REPORT, lines.join("\n") + "\n"); }
  console.log(`\nsweep: ${names.length} tools — OK ${counts.OK}, BUG ${counts.BUG}, TIDAK DIUJI ${counts["TIDAK DIUJI"]}; cross-tool ${hypResults.filter(h => h.ok).length}/${hypResults.length}`);
  if (missing.length) console.log("no sweep entry: " + missing.join(", "));
  if (stale.length) console.log("entry for a removed tool: " + stale.join(", "));
  return counts.BUG === 0 && missing.length === 0 && stale.length === 0 && hypResults.every(h => h.ok) ? 0 : 1;
}

let code = 1;
try { code = await main(); }
catch (e) { console.error("SWEEP CRASHED: " + (e?.stack || e)); }
finally {
  try { await M?.close(); } catch {}
  try { fx?.close(); } catch {}
  rmSync(work, { recursive: true, force: true });
}
process.exit(code);
