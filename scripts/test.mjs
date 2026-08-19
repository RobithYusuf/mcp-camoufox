#!/usr/bin/env node
// Runs every suite and exits non-zero if anything failed.
//   npm test              all suites
//   npm test -- core      just one
//   npm test -- --parallel   all suites at once (each owns its browser + port)
//   MCPC_ONLY=snapshot npm test -- core    just the checks whose name matches
const only = process.argv.slice(2).filter(a => !a.startsWith("-"));
const parallel = process.argv.includes("--parallel");
const suites = [
  ["core", "./test/suite-core.mjs"],
  ["kit", "./test/suite-kit.mjs"],
  ["security", "./test/suite-security.mjs"],
].filter(([name]) => !only.length || only.includes(name));

if (process.env.MCPC_ONLY) {
  console.log(`\n⚠  MCPC_ONLY="${process.env.MCPC_ONLY}" — running a SUBSET. Checks share browser state,`);
  console.log(`   so this is a debugging aid, not a verification. Re-run without it before releasing.\n`);
}

// Each suite spawns its own MCP server, its own fresh-profile browser and an
// OS-assigned fixture port, so they do not collide. Sequential stays the default:
// three browsers at once changes the timing the suites are meant to measure.
const runSuite = async ([name, mod]) => {
  const run = (await import(mod)).default;
  try {
    const res = await run();
    return { name, pass: res.pass, total: res.total, failures: res.failures.map(f => `${name}: ${f.name} — ${f.detail}`) };
  } catch (e) {
    // report the crash and keep going, so one bad suite does not hide the others
    console.log(`\n${name}: SUITE CRASHED — ${String(e?.message || e)}`);   // full message: the detail is the point
    return { name, pass: 0, total: 1, failures: [`${name}: SUITE CRASHED — ${String(e?.message || e).split("\n")[0]}`] };
  }
};

const started = Date.now();
const results = parallel
  ? await Promise.all(suites.map(runSuite))
  : await (async () => { const out = []; for (const s of suites) out.push(await runSuite(s)); return out; })();

let pass = 0, total = 0;
const failures = [];
for (const r of results) { pass += r.pass; total += r.total; failures.push(...r.failures); }
console.log(`\n${parallel ? "parallel" : "sequential"} run took ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`\n${"█".repeat(96)}\nTOTAL: ${pass}/${total} passed, ${total - pass} failed`);
if (failures.length) { console.log("\nFailures:"); for (const f of failures) console.log("  " + f); }
process.exit(failures.length ? 1 : 0);
