#!/usr/bin/env node
// Installs the PUBLISHED package into a throwaway directory and checks that a
// brand-new user can actually launch a browser.
//
// This exists because v0.7.2..0.9.2 were broken for every new install for
// months: camoufox-js declares playwright-core as an unconstrained peer, npm
// resolved 1.62.x, and Camoufox's Juggler schema rejects its setDefaultViewport
// payload. Our own tree kept working on a lockfile-pinned 1.59.1, so no
// dev-tree test could ever have caught it. Run this before announcing a release.
//
//   node scripts/smoke-fresh-install.mjs [version]     (default: latest)
import { spawn, execSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const version = process.argv[2] || "latest";
// The version this working tree intends to publish, to catch a stale install.
const LOCAL_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; }
  catch { return null; }
})();
const dir = mkdtempSync(join(tmpdir(), "mcp-camoufox-smoke-"));
console.log(`[smoke] installing mcp-camoufox@${version} into ${dir}`);
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "smoke", private: true, version: "1.0.0" }));
// --prefer-online: npm caches registry metadata for minutes, and a smoke run
// right after publishing quietly installed the PREVIOUS version and passed.
execSync(`npm install mcp-camoufox@${version} --silent --prefer-online`, { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });

const req = (p) => JSON.parse(execSync(`node -p "JSON.stringify(require('${p}/package.json'))"`, { cwd: dir }).toString());
const pkg = req("./node_modules/mcp-camoufox");
const pw = req("./node_modules/playwright-core");
console.log(`[smoke] mcp-camoufox ${pkg.version} | playwright-core ${pw.version}`);
// Verifying the wrong version is worse than not verifying at all: it hands a
// release a green light it never earned. When run as `latest` from the repo,
// demand that what npm served matches the version we are releasing.
if (version === "latest" && LOCAL_VERSION && pkg.version !== LOCAL_VERSION) {
  console.error(`[smoke] FAIL: npm served ${pkg.version} but this tree is ${LOCAL_VERSION}.`);
  console.error(`[smoke] The registry has not propagated yet, or the publish did not land.`);
  console.error(`[smoke] Wait and re-run, or pin it: node scripts/smoke-fresh-install.mjs ${LOCAL_VERSION}`);
  process.exit(1);
}
if (pw.version.localeCompare("1.61.0", undefined, { numeric: true }) >= 0) {
  console.error(`[smoke] FAIL: playwright-core ${pw.version} >= 1.61 — Camoufox's Juggler rejects Browser.setDefaultViewport with isMobile.`);
  process.exit(1);
}

const proc = spawn("node", [join(dir, "node_modules", "mcp-camoufox", "dist", "index.js")], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "", stderr = "";
const pending = new Map();
proc.stderr.on("data", d => { stderr += d.toString(); });
proc.stdout.on("data", d => {
  buf += d.toString(); let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!l.trim()) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
let id = 0;
const rpc = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
const fail = (msg) => { console.error(`[smoke] FAIL: ${msg}`); if (stderr.trim()) console.error(stderr.slice(0, 800)); proc.kill(); process.exit(1); };
setTimeout(() => fail("timed out"), 180000).unref();

const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
const tools = (await rpc("tools/list", {})).result?.tools || [];
console.log(`[smoke] handshake ok: ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}, ${tools.length} tools`);
if (init.result?.serverInfo?.version !== pkg.version) fail(`handshake version ${init.result?.serverInfo?.version} != package ${pkg.version}`);

const launch = await rpc("tools/call", { name: "browser_launch", arguments: { url: "https://example.com", headless: true, fresh_profile: true } });
const text = (launch.result?.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
if (launch.result?.isError || !text.includes("Browser launched")) fail(`browser_launch did not succeed:\n${text.slice(0, 600)}`);
console.log(`[smoke] ${text.split("\n").slice(0, 2).join(" | ")}`);
await rpc("tools/call", { name: "browser_close", arguments: {} });
proc.kill();
console.log("[smoke] PASS — a fresh install can install, hand-shake and drive a browser.");
