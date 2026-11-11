// The docs must match the running server: runs scripts/audit-tools.mjs as a check, so
// `npm test` fails when the README or docs/TOOLS.md drifts from the tool registry.
// Also guards what every client pays before it does anything: the size of tools/list and
// the work done before initialize answers. No browser is launched here.
import { spawn, spawnSync } from "child_process";
import { rmSync } from "fs";
import { join } from "path";
import { ROOT, DIST, runner, startServer, sandboxHome, until } from "./harness.mjs";

// Characters of JSON.stringify(tools) in the tools/list reply. 64,665 when this was set
// (135 tools; 73,904 before the descriptions were cut). Every client sends all of it to
// the model in every request, so it grew 368 tokens in one release without anyone
// noticing. Raise it on purpose, in the same change that needs the room, never to make
// this pass. Long explanations belong in docs/TOOLS.md, not in a description.
const TOOLS_LIST_BUDGET = 66000;

export default async function run() {
  const { check, report } = runner("suite-docs");
  await check("README and docs/TOOLS.md match the registered tools", async () => {
    const r = spawnSync(process.execPath, [join(ROOT, "scripts", "audit-tools.mjs")], { encoding: "utf8", timeout: 60000 });
    return [r.status === 0, (r.stderr || r.stdout).trim().split("\n").slice(0, 6).join(" | ")];
  });

  await check("tools/list stays within its size budget", async () => {
    const srv = await startServer();
    try {
      const tools = (await srv.rpc("tools/list", {})).result?.tools || [];
      const chars = JSON.stringify(tools).length;
      const biggest = tools.map(t => [t.name, JSON.stringify(t).length]).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([n, c]) => `${n} ${c}`).join(", ");
      return [tools.length > 100 && chars <= TOOLS_LIST_BUDGET, `${tools.length} tools, ${chars} chars (budget ${TOOLS_LIST_BUDGET}); largest: ${biggest}`];
    } finally { srv.kill(); }
  });

  // camoufox-js and playwright-core were 190ms of a 270ms initialize. They are loaded
  // after the handshake instead (warmBrowserModules). A resolve hook in the server's own
  // process names every import of either package on stderr, so this reads what was
  // loaded rather than timing it.
  await check("initialize answers before the browser libraries load, and they load after", async () => {
    const hook = `import { registerHooks } from "node:module";
      registerHooks({ resolve(s, c, next) { const m = /^(camoufox-js|playwright-core)(\\/|$)/.exec(s); if (m) process.stderr.write("[import] " + m[1] + "\\n"); return next(s, c); } });`;
    const home = sandboxHome();
    const proc = spawn(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(hook), DIST],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, USERPROFILE: home } });
    let out = "", err = "";
    proc.stdout.on("data", d => { out += d; });
    proc.stderr.on("data", d => { err += d; });
    try {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "suite", version: "1" } } }) + "\n");
      await until(() => out.includes('"id":1'), 10000, 5);
      if (!out.includes('"id":1')) return [false, `no initialize reply; stderr: ${err.slice(0, 120)}`];
      if (/registerHooks is not a function|does not provide an export named 'registerHooks'/.test(err)) return [false, "this Node has no module.registerHooks (needs 22.15+), so the check cannot run"];
      const atInit = (err.match(/\[import\] \S+/g) || []).join(" ");
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
      await until(() => /\[import\] camoufox-js/.test(err) && /\[import\] playwright-core/.test(err), 10000);
      const later = [...new Set(err.match(/\[import\] \S+/g) || [])].join(" ");
      return [atInit === "" && /camoufox-js/.test(later) && /playwright-core/.test(later),
        `loaded by initialize: ${atInit || "nothing"}; loaded after it: ${later || "nothing"}`];
    } finally { proc.kill(); try { rmSync(home, { recursive: true, force: true }); } catch {} }
  });
  return report();
}
