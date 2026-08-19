#!/usr/bin/env node
// Runs every suite and exits non-zero if anything failed.
//   npm test              all suites
//   npm test -- core      just one
const only = process.argv.slice(2).filter(a => !a.startsWith("-"));
const suites = [
  ["core", "./test/suite-core.mjs"],
  ["kit", "./test/suite-kit.mjs"],
  ["security", "./test/suite-security.mjs"],
];
let pass = 0, total = 0;
const failures = [];
for (const [name, mod] of suites) {
  if (only.length && !only.includes(name)) continue;
  const run = (await import(mod)).default;
  const res = await run();
  pass += res.pass; total += res.total;
  failures.push(...res.failures.map(f => `${name}: ${f.name} — ${f.detail}`));
}
console.log(`\n${"█".repeat(96)}\nTOTAL: ${pass}/${total} passed, ${total - pass} failed`);
if (failures.length) { console.log("\nFailures:"); for (const f of failures) console.log("  " + f); }
process.exit(failures.length ? 1 : 0);
