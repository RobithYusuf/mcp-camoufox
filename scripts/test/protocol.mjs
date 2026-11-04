// A real MCP client for the tests: the SDK's Client over stdio, the server in its
// own process, and the server's HOME pointed at a throwaway directory.
//
// harness.mjs parses JSON-RPC by hand and skips any stdout line it cannot parse,
// so it can never notice stdout pollution or a reply a real client would refuse.
// Hand-written checks there also compare the words in a reply. Checks built on
// this file read the effect back from the page, which is what catches a tool
// that says "done" when nothing happened.
//
// The sandboxed HOME is what makes reset_profile and browser_recover safe to run:
// ~/.camoufox-mcp resolves inside it, so no test can reach a real login. The
// Camoufox binary is linked in rather than downloaded again.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "child_process";
import { rmSync } from "fs";
import { platform } from "os";
import { DIST, sandboxHome } from "./harness.mjs";

/** Every process below `pid`, found by walking ppid. A shared pattern such as
 *  "camoufox" would also match browsers owned by the developer or another agent. */
export function descendants(pid) {
  if (!pid || platform() === "win32") return [];
  let rows;
  try { rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }); }
  catch { return []; }
  const procs = rows.split("\n").map(l => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
  const out = [], seen = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of procs) {
      if (seen.has(p.ppid) && !seen.has(p.pid)) { seen.add(p.pid); out.push(p); grew = true; }
    }
  }
  return out;
}

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function connect({ env = {}, home = null, keepHome = false, dist = process.env.MCP_TEST_DIST || DIST } = {}) {
  const sandbox = home || sandboxHome();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [dist],
    env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox, ...env },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", d => { stderr += d.toString(); });
  const client = new Client({ name: "mcp-camoufox-tests", version: "1" });
  // A line on stdout that is not JSON-RPC lands here, and only here.
  const protocolErrors = [];
  client.onerror = e => protocolErrors.push(String(e?.message || e));
  await client.connect(transport);
  const pid = transport.pid;

  const call = async (name, args = {}, { timeoutMs = 60000 } = {}) => {
    const started = Date.now();
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs, maxTotalTimeout: timeoutMs });
    const content = res.content || [];
    return {
      text: content.filter(c => c.type === "text").map(c => c.text).join("\n"),
      // The tool's own answer. A later text item is a note the server added, such as a
      // dialog that appeared during the call.
      first: content.find(c => c.type === "text")?.text ?? "",
      isError: !!res.isError,
      kinds: content.map(c => c.type),
      images: content.filter(c => c.type === "image"),
      seconds: (Date.now() - started) / 1000,
    };
  };

  const browsers = () => descendants(pid).filter(p => /-profile\s/.test(p.command) && /-juggler-pipe/.test(p.command));

  const close = async () => {
    try { await call("browser_close", {}, { timeoutMs: 20000 }); } catch {}
    try { await client.close(); } catch {}
    if (!home && !keepHome) { try { rmSync(sandbox, { recursive: true, force: true }); } catch {} }
  };

  return { client, transport, pid, home: sandbox, call, close, browsers, stderr: () => stderr, protocolErrors };
}

/** Launch arguments every test should use: headless, a temp profile, and no GeoIP
 *  lookup, which would otherwise call a public IP service from a local test. */
export const LOCAL_LAUNCH = { headless: true, fresh_profile: true, geoip: false };
