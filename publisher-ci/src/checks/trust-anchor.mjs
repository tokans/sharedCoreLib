// CONTROL: §2/§3 of THREAT_MODEL.md — the root of trust must be baked, immutable,
// offline, and HTTPS; new-app onboarding must chain to the root. Validates the app's
// declared trust manifest (publisher.trust.json).
import { join } from "node:path";
import { readJson, fileExists } from "../util.mjs";

export default {
  id: "trust-anchor",
  title: "Baked, immutable, offline root of trust",
  severity: "critical",
  run({ appDir, config }) {
    const path = join(appDir, config.trustManifest);
    const findings = [];
    if (!fileExists(path)) {
      return {
        status: "fail",
        findings: [{
          level: "critical",
          message: `trust manifest "${config.trustManifest}" not found`,
          hint: "run `sharedcorelib-publisher-ci init` to scaffold it",
        }],
      };
    }
    const m = readJson(path);
    if (!m || m.__parseError) {
      return { status: "fail", findings: [{ level: "critical", message: `${config.trustManifest} is not valid JSON` }] };
    }

    const root = m.root ?? {};
    if (!root.publicKeyHex) findings.push({ level: "critical", message: "root.publicKeyHex missing — no baked anchor" });
    if (root.immutable !== true) findings.push({ level: "critical", message: "root.immutable must be true (anchor cannot change after install)" });
    if (root.offline !== true) findings.push({ level: "high", message: "root.offline should be true (key held offline / HSM)" });

    const feed = m.feed ?? {};
    if (feed.anchorSource !== "baked") {
      findings.push({
        level: "critical",
        message: `feed.anchorSource is "${feed.anchorSource}" — must be "baked"`,
        hint: "the root anchor must never be read from the feed (it could repoint trust)",
      });
    }
    if (config.feed?.requireHttps && feed.baseUrl && !/^https:\/\//i.test(feed.baseUrl)) {
      findings.push({ level: "critical", message: `feed.baseUrl is not HTTPS: ${feed.baseUrl}` });
    }

    const onboarding = m.newAppOnboarding ?? {};
    if (onboarding.requireRootDelegation !== true) {
      findings.push({
        level: "high",
        message: "newAppOnboarding.requireRootDelegation must be true",
        hint: "a new app's anchor must be signed by the root, so a hostile feed can't onboard a rogue app",
      });
    }

    return { status: findings.length ? "fail" : "pass", findings };
  },
};
