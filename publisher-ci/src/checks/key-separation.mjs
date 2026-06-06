// CONTROL: §2 — code-signing ≠ data-signing ≠ root, each delegated by the root, with
// a k-of-n threshold on the high-value code-signing role. Compromise of the low-value
// data key must never yield code-execution authority.
import { join } from "node:path";
import { readJson, fileExists } from "../util.mjs";

const REQUIRED_ROLES = ["data", "code", "snapshot", "timestamp"];

export default {
  id: "key-separation",
  title: "Separate, root-delegated signing roles",
  severity: "critical",
  run({ appDir, config }) {
    const path = join(appDir, config.trustManifest);
    if (!fileExists(path)) return { status: "skip", findings: [{ level: "info", message: "no trust manifest (see trust-anchor)" }] };
    const m = readJson(path);
    if (!m || m.__parseError) return { status: "skip", findings: [{ level: "info", message: "trust manifest unreadable" }] };

    const findings = [];
    const del = m.delegations ?? {};
    const keys = new Map(); // publicKeyHex -> roleName, to detect reuse

    const rootKey = m.root?.publicKeyHex;
    if (rootKey) keys.set(rootKey, "root");

    for (const role of REQUIRED_ROLES) {
      const d = del[role];
      if (!d) { findings.push({ level: "critical", message: `delegations.${role} missing` }); continue; }
      if (!d.publicKeyHex) { findings.push({ level: "critical", message: `delegations.${role}.publicKeyHex missing` }); continue; }
      if (d.signedByRoot !== true) {
        findings.push({ level: "critical", message: `delegations.${role} is not signedByRoot`, hint: "operational keys must be delegated by the immutable root so they can rotate" });
      }
      const prior = keys.get(d.publicKeyHex);
      if (prior) {
        findings.push({ level: "critical", message: `delegations.${role} reuses the ${prior} key`, hint: "every role must use a distinct key" });
      } else {
        keys.set(d.publicKeyHex, role);
      }
    }

    const code = del.code;
    if (code && (typeof code.threshold !== "number" || code.threshold < 2)) {
      findings.push({ level: "high", message: `delegations.code.threshold should be ≥ 2 (k-of-n), got ${code.threshold ?? "unset"}` });
    }

    const ts = del.timestamp;
    if (ts && typeof ts.maxExpiryDays === "number" && ts.maxExpiryDays > 14) {
      findings.push({ level: "medium", message: `timestamp.maxExpiryDays ${ts.maxExpiryDays} is long — shorter expiry resists freeze/replay` });
    }

    return { status: findings.some((f) => f.level === "critical" || f.level === "high") ? "fail" : findings.length ? "warn" : "pass", findings };
  },
};
