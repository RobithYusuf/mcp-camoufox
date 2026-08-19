#!/usr/bin/env node
// Diff the documentation against the server's real tool registry.
//
// This exists because the tables drift silently: a tool added without a doc row,
// or a category heading whose count was never bumped ("Debug (5)" while the table
// listed 6). Counting by eye had already missed both.
//
//   node scripts/audit-tools.mjs
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS_MD = join(ROOT, "docs", "TOOLS.md");
const README = join(ROOT, "README.md");

const registry = await new Promise((resolve, reject) => {
  const proc = spawn("node", [join(ROOT, "dist", "index.js")], { stdio: ["pipe", "pipe", "ignore"] });
  let buf = "";
  const timer = setTimeout(() => { proc.kill(); reject(new Error("server did not answer tools/list in 20s")); }, 20000);
  proc.stdout.on("data", d => {
    buf += d.toString();
    for (const line of buf.split("\n")) {
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m?.result?.tools) { clearTimeout(timer); proc.kill(); resolve(m.result.tools.map(t => t.name)); }
    }
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "audit", version: "1" } } }) + "\n");
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
});

const doc = readFileSync(TOOLS_MD, "utf8");
const readme = readFileSync(README, "utf8");
const problems = [];

// 1. every registered tool has a row of its own
const sections = doc.split(/^### /m).slice(1);
const documented = new Set();
let declaredTotal = 0;
for (const s of sections) {
  const head = s.split("\n")[0];
  const m = head.match(/^(.+?) \((\d+)\)\s*$/);
  if (!m) continue;
  const names = [];
  for (const line of s.split("\n")) {
    if (!line.startsWith("|")) continue;
    const first = line.split("|")[1] || "";
    for (const t of first.matchAll(/`([a-z][a-z0-9_]{2,})`/g)) {
      if (registry.includes(t[1]) && !names.includes(t[1])) names.push(t[1]);
    }
  }
  names.forEach(n => documented.add(n));
  declaredTotal += Number(m[2]);
  if (names.length !== Number(m[2])) {
    problems.push(`docs/TOOLS.md — "${m[1]}" heading says ${m[2]}, its Tool column lists ${names.length}`);
  }
}
const undocumented = registry.filter(n => !documented.has(n));
if (undocumented.length) problems.push(`docs/TOOLS.md — not documented: ${undocumented.join(", ")}`);

// 2. the headline counts agree with reality
if (declaredTotal !== registry.length) {
  problems.push(`docs/TOOLS.md — category counts sum to ${declaredTotal}, the server registers ${registry.length}`);
}
for (const [label, text] of [["README.md", readme]]) {
  for (const m of text.matchAll(/\*\*(\d+) tools\*\*|## All (\d+) Tools|\| \*\*(\d+)\*\* \|/g)) {
    const n = Number(m[1] || m[2] || m[3]);
    if (n !== registry.length) problems.push(`${label} — says ${n} where the server registers ${registry.length}: "${m[0]}"`);
  }
}

console.log(`tools registered: ${registry.length} | documented: ${documented.size} | categories: ${sections.length}`);
if (problems.length) {
  console.error(`\nFAIL — ${problems.length} documentation mismatch(es):`);
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log("PASS — docs match the tool registry.");
