// The docs must match the running server: runs scripts/audit-tools.mjs as a check, so
// `npm test` fails when the README or docs/TOOLS.md drifts from the tool registry.
import { spawnSync } from "child_process";
import { join } from "path";
import { ROOT, runner } from "./harness.mjs";

export default async function run() {
  const { check, report } = runner("suite-docs");
  await check("README and docs/TOOLS.md match the registered tools", async () => {
    const r = spawnSync(process.execPath, [join(ROOT, "scripts", "audit-tools.mjs")], { encoding: "utf8", timeout: 60000 });
    return [r.status === 0, (r.stderr || r.stdout).trim().split("\n").slice(0, 6).join(" | ")];
  });
  return report();
}
