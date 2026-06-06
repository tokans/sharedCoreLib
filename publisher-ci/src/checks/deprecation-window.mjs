// CONTROL: principle #6 — the shared runtime may only remove an API after a 3-version
// deprecation window. Validates a deprecations ledger (deprecations.json): every entry
// must keep `removeAt - since >= window` (major.minor distance), and nothing may be
// scheduled for removal at or below the version the app currently targets while the
// window has not elapsed.
import { join } from "node:path";
import { readJson, fileExists } from "../util.mjs";
import { parseSemver } from "../util.mjs";

/** Distance in "versions" using major*1000 + minor so 1.0 → 1.3 == 3. */
function versionDistance(a, b) {
  const [am, an] = parseSemver(a);
  const [bm, bn] = parseSemver(b);
  return (bm * 1000 + bn) - (am * 1000 + an);
}

export default {
  id: "deprecation-window",
  title: "3-version deprecation window honored",
  severity: "high",
  run({ appDir, config }) {
    const path = join(appDir, config.deprecations);
    if (!fileExists(path)) {
      return { status: "skip", findings: [{ level: "info", message: `no ${config.deprecations} ledger — skipped (only the lib publisher maintains one)` }] };
    }
    const ledger = readJson(path);
    if (!ledger || ledger.__parseError) return { status: "fail", findings: [{ level: "high", message: `${config.deprecations} is not valid JSON` }] };

    const window = config.deprecationWindow ?? 3;
    const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
    const findings = [];

    for (const e of entries) {
      if (!e.api || !e.since || !e.removeAt) {
        findings.push({ level: "medium", message: `incomplete ledger entry: ${JSON.stringify(e)}` });
        continue;
      }
      const dist = versionDistance(e.since, e.removeAt);
      if (dist < window) {
        findings.push({
          level: "high",
          message: `"${e.api}" removed too soon: since ${e.since} → removeAt ${e.removeAt} (${dist} < ${window})`,
          hint: `schedule removal no earlier than v${parseSemver(e.since)[0]}.${parseSemver(e.since)[1] + window}`,
        });
      }
    }

    if (config.coreVersion) {
      for (const e of entries) {
        if (e.removeAt && versionDistance(config.coreVersion, e.removeAt) > 0 && e.removedInCode) {
          findings.push({ level: "high", message: `"${e.api}" is removedInCode but its removeAt ${e.removeAt} is after the targeted core ${config.coreVersion}` });
        }
      }
    }

    return { status: findings.some((f) => f.level === "high") ? "fail" : findings.length ? "warn" : "pass", findings };
  },
};
