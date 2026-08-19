// Shared test harness: drives dist/index.js over real MCP stdio, serves local
// fixtures, and reports PASS/FAIL. No dependencies beyond Node.
import { spawn } from "child_process";
import http from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DIST = join(ROOT, "dist", "index.js");

/** Spawn the MCP server and return a client. `call` returns the flattened text
 *  of a tool result, prefixed with "IS_ERROR: " when the tool reported one, and
 *  "[IMAGE …]" when it returned image content. */
export async function startServer(distPath = DIST) {
  const proc = spawn("node", [distPath], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", stderr = "";
  const pending = new Map();
  proc.stderr.on("data", d => { stderr += d.toString(); });
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
  const rpc = (method, params) => new Promise(res => {
    const i = ++id; pending.set(i, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  });
  const call = async (name, args = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    if (r.error) return `RPC_ERROR: ${r.error.message}`;
    const items = r.result?.content || [];
    const text = items.filter(c => c.type === "text").map(c => c.text).join("\n");
    const img = items.find(c => c.type === "image");
    return (r.result?.isError ? "IS_ERROR: " : "") + (img ? `[IMAGE ${img.mimeType} b64len=${img.data.length}]\n` : "") + text;
  };
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "suite", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  return { proc, rpc, call, stderr: () => stderr, kill: () => proc.kill() };
}

/** Minimal fixture server. `routes` maps a pathname to (req,res,state)=>void. */
export async function fixtureServer(routes, port) {
  const state = {};
  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    const handler = routes[path] || routes["*"];
    if (!handler) { res.writeHead(404); return res.end("no route"); }
    handler(req, res, state);
  });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${port}`, port, state, close: () => server.close() };
}

export function html(body, title = "Fixture") {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

/** Pull a snapshot ref out of browser_snapshot output by a substring match. */
export function refOf(snapshot, needle) {
  const line = (snapshot || "").split("\n").find(l => l.includes("ref=") && l.includes(needle));
  return line ? line.trim().split(/\s+/)[0].replace("ref=", "") : null;
}

export function runner(suiteName) {
  const results = [];
  const check = async (name, fn) => {
    try {
      const [ok, detail] = await fn();
      results.push({ name, ok, detail: String(detail ?? "").replace(/\s+/g, " ").slice(0, 140) });
    } catch (e) {
      results.push({ name, ok: false, detail: "THREW: " + String(e?.message || e).replace(/\s+/g, " ").slice(0, 140) });
    }
  };
  const report = () => {
    const pass = results.filter(r => r.ok).length;
    console.log(`\n${"=".repeat(96)}\n${suiteName}`);
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(52)} ${r.detail}`);
    console.log(`${"=".repeat(96)}\n${suiteName}: ${pass}/${results.length} passed, ${results.length - pass} failed`);
    return { pass, total: results.length, failures: results.filter(r => !r.ok) };
  };
  return { check, report, results };
}
