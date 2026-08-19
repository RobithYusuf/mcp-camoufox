// Security regressions. Every check here corresponds to a real defect that
// shipped at some point — none of them are hypothetical.
import { startServer, fixtureServer, html, refOf, runner } from "./harness.mjs";
import { statSync, existsSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const VICTIM = 39521, ATTACKER = 39522;

export default async function run() {
  const { check, report } = runner("suite-security");
  let attackerCookie = "__never_called__";
  const victim = await fixtureServer({
    "/redirect": (q, r) => { r.writeHead(302, { Location: `http://localhost:${ATTACKER}/steal` }); r.end(); },
    "*": (q, r) => {
      r.writeHead(200, { "content-type": "text/html" });
      r.end(html(`<input id="pw" name="password" type="password"><input id="u" name="user" type="text"><button id="b" type="button">Nothing</button>`, "Sec"));
    },
  }, VICTIM);
  const attacker = await fixtureServer({
    "*": (q, r) => { attackerCookie = q.headers.cookie || null; r.writeHead(200); r.end("ok"); },
  }, ATTACKER);

  const S = await startServer();
  const c = S.call;
  await c("browser_launch", { url: victim.url, headless: true, fresh_profile: true });
  await c("cookie_set", { name: "AUTH", value: "victim-session-token", domain: "127.0.0.1", expires_days: 1 });

  // v0.9.6: impit replayed the Cookie header onto a cross-origin redirect target
  await check("cookies do NOT survive a cross-origin redirect", async () => {
    const t = await c("http_request", { url: `${victim.url}/redirect`, max_chars: 100 });
    const leaked = attackerCookie && attackerCookie !== "__never_called__";
    return [!leaked, leaked ? `LEAKED ${attackerCookie}` : `attacker got no cookie; trail: ${(t.split("\n").find(l => l.startsWith("redirects:")) || "").slice(0, 70)}`];
  });
  // scoping for direct (non-redirect) requests
  await check("cookies are scoped to the request host", async () => {
    const t = await c("http_request", { url: `http://localhost:${VICTIM}/`, max_chars: 60 });
    return [!t.includes("victim-session-token"), "127.0.0.1 cookie not sent to localhost"];
  });

  // v0.9.6: snapshot/inspect printed password values verbatim
  await check("password values never leave the browser", async () => {
    await c("evaluate", { expression: "document.getElementById('pw').value='SuperSecret123';'ok'" });
    const snap = await c("browser_snapshot");
    const ins = await c("inspect_element", { ref: refOf(snap, "type=password") });
    return [!snap.includes("SuperSecret123") && !ins.includes("SuperSecret123"), "snapshot + inspect_element masked"];
  });
  // v0.9.5: fill echoed whatever it typed
  await check("fill masks a secret field, echoes a normal one", async () => {
    const snap = await c("browser_snapshot");
    const pw = await c("fill", { ref: refOf(snap, "type=password"), value: "hunter2-SECRET" });
    const tx = await c("fill", { ref: refOf(snap, "type=text"), value: "visible-value" });
    return [!pw.includes("hunter2") && pw.includes("masked") && tx.includes("visible-value"), "masked/echoed correctly"];
  });
  await check("cookie_set masks the value", async () => {
    const t = await c("cookie_set", { name: "s", value: "TOKEN-abcdef123456", domain: "127.0.0.1" });
    return [!t.includes("abcdef123456"), t.slice(0, 50)];
  });

  // v0.9.5: name params escaped their directory
  await check("screenshot name cannot escape its directory", async () => {
    const escaped = join(tmpdir(), "mcpc-pwned-shot.png");
    if (existsSync(escaped)) rmSync(escaped);
    await c("screenshot", { name: "../../../../../../tmp/mcpc-pwned-shot", return_image: false });
    return [!existsSync(escaped), existsSync(escaped) ? "TRAVERSED" : "contained"];
  });
  await check("auth_capture name cannot escape its directory", async () => {
    const escaped = join(tmpdir(), "mcpc-pwned-auth.json");
    if (existsSync(escaped)) rmSync(escaped);
    await c("auth_capture", { name: "../../../../../../tmp/mcpc-pwned-auth" });
    return [!existsSync(escaped), existsSync(escaped) ? "TRAVERSED" : "contained"];
  });

  // v0.9.5: credential files were world-readable
  await check("credential files are written 0600", async () => {
    const files = [];
    await c("auth_capture", { name: "suite-sec" });
    files.push(join(homedir(), ".camoufox-mcp", "sessions", "suite-sec.json"));
    const ck = join(tmpdir(), "mcpc-sec-cookies.json");
    const st = join(tmpdir(), "mcpc-sec-state.json");
    await c("cookie_export_file", { path: ck });
    await c("storage_state_save", { path: st });
    files.push(ck, st);
    const modes = files.filter(existsSync).map(f => (statSync(f).mode & 0o777).toString(8));
    return [modes.length === 3 && modes.every(m => m === "600"), `modes=${modes.join(",")}`];
  });

  // v0.9.6: two concurrent launches each built a context
  await check("concurrent browser_launch builds ONE context", async () => {
    await c("browser_close");
    const [a, b] = await Promise.all([
      c("browser_launch", { url: victim.url, headless: true, fresh_profile: true }),
      c("browser_launch", { url: victim.url, headless: true, fresh_profile: true }),
    ]);
    const launched = [a, b].filter(x => x.includes("Browser launched")).length;
    return [launched === 1, `${launched} launched, ${2 - launched} reused`];
  });

  await c("browser_close");
  S.kill(); victim.close(); attacker.close();
  return report();
}
