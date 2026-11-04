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
// Snake_case words in the README that are parameters or settings, not tools.
const KNOWN_NON_TOOLS = new Set(["fresh_profile", "no_viewport", "reveal_values", "expires_days", "full_page", "last_exit", "fields_json", "submit_label", "access_token", "cf_clearance"]);

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
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
for (const [label, text] of [["README.md", readme], ["package.json description", pkg.description], ["AGENTS.md", agents], ["docs/TOOLS.md", doc.split("\n")[0]]]) {
  for (const m of text.matchAll(/\b(\d+) tools\b/gi)) {
    if (Number(m[1]) !== registry.length) problems.push(`${label} — says ${m[1]} where the server registers ${registry.length}: "${m[0]}"`);
  }
}
if (!/\b\d+ tools\b/i.test(readme)) problems.push("README.md — no longer states the tool count");

// 3. the README's group tables agree with docs/TOOLS.md, group by group
const docGroups = new Map(sections.map(s => {
  const m = s.split("\n")[0].match(/^(.+?) \((\d+)\)\s*$/);
  return m ? [m[1].replace(/\s*\(.*\)$/, ""), Number(m[2])] : null;
}).filter(Boolean));
let readmeSum = 0;
for (const m of readme.matchAll(/^\| ([^|`]+?) \| (\d+) \| `/gm)) {
  readmeSum += Number(m[2]);
  if (docGroups.get(m[1]) !== Number(m[2])) problems.push(`README.md — group "${m[1]}" says ${m[2]}, docs/TOOLS.md says ${docGroups.get(m[1]) ?? "no such group"}`);
}
if (readmeSum !== registry.length) problems.push(`README.md — the group tables add up to ${readmeSum}, the server registers ${registry.length}`);
for (const t of readme.matchAll(/`([a-z]+_[a-z0-9_]+)`/g)) {
  if (!registry.includes(t[1]) && !KNOWN_NON_TOOLS.has(t[1])) problems.push(`README.md — mentions \`${t[1]}\`, which is not a registered tool`);
}

// 4. the README's plain-language rules, which drift the moment nobody is looking
for (const [rx, why] of [
  [/\bpkill\b|\bkillall\b/i, "advice to kill processes by pattern also hits the server and other agents' browsers"],
  [/rm\s+-rf/i, "advice to delete folders can destroy a profile holding real logins"],
  [/—/, "no em dashes"],
  [/\b(unique|undetectable|bypasses|most feature-rich|100%|zero automation)\b/i, "no promotional or absolute claims"],
  [/⭐|★/, "no star ratings"],
  [/\b(gpt-[0-9o]|claude-[0-9a-z]|gemini-[0-9]|opus [0-9]|sonnet [0-9])/i, "no specific AI model names, use your-vision-model"],
  [/^#+ .*[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/mu, "no emoji in headings"],
]) {
  const hit = readme.match(rx);
  if (hit) problems.push(`README.md — "${hit[0].slice(0, 40)}": ${why}`);
}

console.log(`tools registered: ${registry.length} | documented: ${documented.size} | categories: ${sections.length}`);
if (problems.length) {
  console.error(`\nFAIL — ${problems.length} documentation mismatch(es):`);
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log("PASS — docs match the tool registry.");
