#!/usr/bin/env node
// Dump every registered tool's name + JSON schema, sorted and stable.
// Used to prove a refactor changed no part of the public MCP surface:
//   node scripts/tool-schema-snapshot.mjs > /tmp/before.json
//   ...refactor...
//   node scripts/tool-schema-snapshot.mjs > /tmp/after.json && diff /tmp/before.json /tmp/after.json
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const proc = spawn("node", [join(root, "dist", "index.js")], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map();
proc.stdout.on("data", d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
let id = 0;
const rpc = (method, params) => new Promise(r => {
  const i = ++id; pending.set(i, r);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
});

const timer = setTimeout(() => { console.error("timeout waiting for tools/list"); process.exit(1); }, 30000);
await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "schema-snapshot", version: "1" } });
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
const tools = (await rpc("tools/list", {})).result?.tools || [];
clearTimeout(timer);
proc.kill();

const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  }
  return v;
};
const out = tools
  .map(t => ({ name: t.name, description: t.description, inputSchema: sortKeys(t.inputSchema) }))
  .sort((a, b) => a.name.localeCompare(b.name));
console.log(JSON.stringify({ count: out.length, tools: out }, null, 2));
