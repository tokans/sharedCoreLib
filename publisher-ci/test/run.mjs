// Tiny regression runner for the checks themselves — no test framework, Node built-ins only.
// Asserts the passing fixture passes, the failing fixture trips each check, and skipChecks works.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { CHECKS } from "../src/checks/index.mjs";
import { runAll, summarize } from "../src/runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => resolve(HERE, "..", "fixtures", name);

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); }
  else { console.error(`  ✗ ${msg}`); failures++; }
}

async function runFixture(name, skipChecks = []) {
  const { config } = loadConfig(fixture(name));
  if (skipChecks.length) config.skipChecks = skipChecks;
  const active = CHECKS.filter((c) => !(config.skipChecks ?? []).includes(c.id));
  const results = await runAll({ appDir: fixture(name), config }, active);
  const summary = summarize(results, config.failOn);
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  return { results, summary, byId };
}

console.log("\n  publisher-ci self-test\n  " + "─".repeat(30));

// 1. Passing fixture must pass.
{
  const { summary, byId } = await runFixture("passing");
  assert(summary.failed === false, "passing fixture: overall PASS");
  assert(byId["trust-anchor"].status === "pass", "passing: trust-anchor pass");
  assert(byId["key-separation"].status === "pass", "passing: key-separation pass");
  assert(byId["kdf-floor"].status === "pass", "passing: kdf-floor pass");
  assert(byId["release-pipeline"].status === "pass", "passing: release-pipeline pass");
}

// 2. Failing fixture must trip each check.
{
  const { summary, byId } = await runFixture("failing");
  assert(summary.failed === true, "failing fixture: overall FAIL");
  for (const id of ["trust-anchor", "key-separation", "update-metadata", "kdf-floor", "tls-only", "dependency-pinning", "release-pipeline"]) {
    assert(byId[id].status === "fail", `failing: ${id} reports fail`);
  }
  // Specific high-signal detections.
  const kdf = byId["kdf-floor"].findings.map((f) => f.message).join(" | ");
  assert(/below floor/.test(kdf), "failing: kdf-floor flags weak iterations");
  assert(/Math\.random/.test(kdf), "failing: kdf-floor flags Math.random secret");
  const tls = byId["tls-only"].findings.map((f) => f.message).join(" | ");
  assert(/http:\/\//.test(tls), "failing: tls-only flags plaintext URL");
  const relp = byId["release-pipeline"].findings.map((f) => f.message).join(" | ");
  assert(/PUBLISH_TOKEN/.test(relp), "failing: release-pipeline flags missing PUBLISH_TOKEN");
  assert(/PRIVATE_KEY/.test(relp), "failing: release-pipeline flags signing key in CI");
}

// 3. skipChecks removes a check from the run.
{
  const allFailing = ["trust-anchor", "key-separation", "update-metadata", "kdf-floor", "tls-only", "dependency-pinning", "release-pipeline"];
  const { summary, results } = await runFixture("failing", allFailing);
  assert(summary.failed === false, "skipChecks: skipping all failing checks → PASS");
  assert(results.every((r) => !allFailing.includes(r.id)), "skipChecks: skipped checks absent from results");
}

console.log("  " + "─".repeat(30));
if (failures) { console.error(`  RESULT: ${failures} assertion(s) failed\n`); process.exit(1); }
console.log("  RESULT: all assertions passed\n");
