// CONTROL: §3 — releases must carry TUF-style metadata: a monotonic snapshot version
// (anti-rollback), short-expiry timestamp (anti-freeze/replay), and an anti-rollback
// floor. Validates the app's release.signing.json.
import { join } from "node:path";
import { readJson, fileExists } from "../util.mjs";

export default {
  id: "update-metadata",
  title: "Anti-rollback + freshness metadata in releases",
  severity: "high",
  run({ appDir, config }) {
    const path = join(appDir, config.releaseSigning);
    if (!fileExists(path)) {
      return {
        status: "fail",
        findings: [{
          level: "high",
          message: `release signing config "${config.releaseSigning}" not found`,
          hint: "declare monotonic snapshot + expiring timestamp metadata for the updater",
        }],
      };
    }
    const s = readJson(path);
    if (!s || s.__parseError) return { status: "fail", findings: [{ level: "high", message: `${config.releaseSigning} is not valid JSON` }] };

    const findings = [];
    if (s.monotonicVersion !== true) findings.push({ level: "high", message: "monotonicVersion must be true (anti-rollback)" });
    if (s.antiRollback !== true) findings.push({ level: "high", message: "antiRollback must be true (refuse versions below the highest seen)" });
    if (!s.snapshot?.enabled) findings.push({ level: "high", message: "snapshot role must be enabled (binds the consistent artifact set)" });
    if (!s.timestamp?.enabled) findings.push({ level: "high", message: "timestamp role must be enabled (freshness proof)" });
    const exp = s.timestamp?.expiryDays;
    if (s.timestamp?.enabled && (typeof exp !== "number" || exp <= 0 || exp > 14)) {
      findings.push({ level: "medium", message: `timestamp.expiryDays should be a small positive number (≤14), got ${exp ?? "unset"}` });
    }
    if (!s.transparencyLog?.enabled) {
      findings.push({ level: "low", message: "transparencyLog disabled — binary transparency makes a malicious update detectable", hint: "Sigstore/Rekor-style append-only log" });
    }

    const hasFail = findings.some((f) => f.level === "high");
    return { status: hasFail ? "fail" : findings.length ? "warn" : "pass", findings };
  },
};
