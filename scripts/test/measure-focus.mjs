#!/usr/bin/env node
// Does a HEADED browser take keyboard focus from the app the developer is typing in?
// Samples `lsappinfo front` about every 20 ms while the server launches, navigates and
// opens tabs, and prints what it saw. macOS only, and it opens a real window for a few
// seconds, so it is a manual measurement and not part of `npm test`.
//
//   node scripts/test/measure-focus.mjs
import { execFile, execFileSync } from "child_process";
import { platform } from "os";
import { connect } from "./protocol.mjs";
import { auditFixture } from "./fixture-audit.mjs";

if (platform() !== "darwin") { console.log("SKIP: lsappinfo exists only on macOS."); process.exit(0); }

const frontNow = () => new Promise(resolve => {
  execFile("lsappinfo", ["front"], { encoding: "utf8" }, (e, out) => resolve(e ? "" : out.trim()));
});
const nameOf = asn => {
  try { return (execFileSync("lsappinfo", ["info", "-only", "name", asn], { encoding: "utf8" }).match(/"([^"]+)"\s*$/m) || [])[1] || asn; }
  catch { return asn; }
};

const samples = [];
let sampling = true, step = "start";
const sampler = (async () => {
  while (sampling) {
    const started = Date.now();
    samples.push({ t: started, asn: await frontNow(), step });
    const pause = 20 - (Date.now() - started);
    if (pause > 0) await new Promise(r => setTimeout(r, pause));
  }
})();

const fx = await auditFixture();
const s = await connect();
const before = (await frontNow());
const durations = {};
const run = async (name, tool, args) => {
  step = name;
  const t0 = Date.now();
  const r = await s.call(tool, args);
  durations[name] = Date.now() - t0;
  if (r.isError) console.log(`  ${name} failed: ${r.text.slice(0, 120)}`);
  await new Promise(res => setTimeout(res, 300));   // a late activation still counts
};
try {
  await run("launch", "browser_launch", { headless: false, fresh_profile: true, geoip: false, url: fx.url });
  await run("navigate", "navigate", { url: fx.url + "/second" });
  await run("tab_new", "tab_new", { url: fx.url + "/short" });
  await run("tab_select", "tab_select", { index: 0 });
  await run("click", "click_text", { text: "Second Page" });
  await run("screenshot", "screenshot", { name: "focus", return_image: false });
  await run("close", "browser_close", {});
} finally {
  sampling = false; await sampler;
  await s.close(); fx.close();
}

const names = new Map();
const label = a => { if (!names.has(a)) names.set(a, nameOf(a)); return names.get(a); };
const home = label(before);
console.log(`front app at the start: ${home}; ${samples.length} samples, median gap ${median(samples)} ms`);
console.log(`step durations: ${Object.entries(durations).map(([k, v]) => `${k}=${v}ms`).join(" ")}`);
let changes = 0, awayMs = 0;
for (let i = 1; i < samples.length; i++) {
  const a = samples[i - 1], b = samples[i];
  if (a.asn !== before) awayMs += b.t - a.t;
  if (a.asn !== b.asn) { changes++; console.log(`  +${b.t - samples[0].t}ms during ${b.step}: ${label(a.asn)} -> ${label(b.asn)}`); }
}
console.log(`front app changed ${changes} time(s); ${awayMs} ms away from ${home}`);
function median(list) {
  const gaps = list.slice(1).map((x, i) => x.t - list[i].t).sort((p, q) => p - q);
  return gaps[Math.floor(gaps.length / 2)] ?? 0;
}
process.exit(0);
