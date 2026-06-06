// CONTROL: §8 (supply chain) — the shared runtime executes across all apps, so its
// security-critical deps must be exactly pinned and a lockfile must exist. Flags
// floating ranges (^, ~, *, latest, >=) on critical deps and a missing lockfile.
import { join } from "node:path";
import { readJson, fileExists } from "../util.mjs";

const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json"];
const FLOATING = /^[\^~>]|^\*$|^latest$|\bx\b/i;

export default {
  id: "dependency-pinning",
  title: "Pinned critical deps + lockfile",
  severity: "medium",
  run({ appDir, config }) {
    const findings = [];

    if (!LOCKFILES.some((f) => fileExists(join(appDir, f)))) {
      findings.push({ level: "high", message: "no lockfile found", hint: "commit a lockfile so dependency versions + integrity hashes are reproducible" });
    }

    const pkg = readJson(join(appDir, "package.json"));
    if (!pkg || pkg.__parseError) {
      findings.push({ level: "medium", message: "package.json missing or unreadable" });
      return { status: "warn", findings };
    }

    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
    for (const dep of config.criticalDeps ?? []) {
      const spec = all[dep];
      if (spec == null) continue; // not used by this app
      if (spec.startsWith("file:") || spec.startsWith("workspace:")) continue; // local link is fine
      if (FLOATING.test(spec)) {
        findings.push({ level: "medium", message: `critical dep "${dep}" uses a floating range "${spec}"`, file: "package.json", hint: "pin to an exact version" });
      }
    }

    const hasHigh = findings.some((f) => f.level === "high");
    return { status: hasHigh ? "fail" : findings.length ? "warn" : "pass", findings };
  },
};
