// CONTROL: cross-account publishing alignment. The release workflow must publish to the
// publisher account using a PUBLISH_TOKEN (the built-in GITHUB_TOKEN can't write
// cross-account), and must NOT carry feed/code signing private keys (signing is OFFLINE
// per THREAT_MODEL §2). Skips cleanly when no release workflow is present.
import { join } from "node:path";
import { read, fileExists } from "../util.mjs";

// Feed/code signing keys that must never appear in CI. Deliberately scoped so OS-level
// app-bundle signing (a separate concern) isn't falsely flagged.
const CI_SIGNING_KEY = /(MASTERS|SUITE|FEED|UPDATER|RUNTIME|CODE)_[A-Z0-9_]*PRIVATE_KEY|SIGNING_PRIVATE_KEY/;

export default {
  id: "release-pipeline",
  title: "Cross-account publish uses PUBLISH_TOKEN, no signing keys in CI",
  severity: "high",
  run({ appDir, config }) {
    const rel = config.release ?? {};
    const path = join(appDir, rel.workflow ?? ".github/workflows/release.yml");
    if (!fileExists(path)) {
      return { status: "skip", findings: [{ level: "info", message: "no release workflow — skipped (add one with `init` to publish builds)" }] };
    }
    const wf = read(path) ?? "";
    const findings = [];

    if (rel.requirePublishToken !== false && !/secrets\.PUBLISH_TOKEN/.test(wf)) {
      findings.push({
        level: "high", file: rel.workflow, message: "release workflow does not use secrets.PUBLISH_TOKEN",
        hint: "cross-account publish needs a PAT with contents:write on the publisher repo; GITHUB_TOKEN can't write cross-account",
      });
    }

    const owner = rel.publishOwner;
    if (owner && !new RegExp(`PUBLISH_REPO\\s*:\\s*${owner}/`).test(wf)) {
      findings.push({
        level: "medium", file: rel.workflow, message: `PUBLISH_REPO is not set to ${owner}/<repo>`,
        hint: `publish builds to the ${owner} account under a repo named for this source repo`,
      });
    }

    if (rel.forbidInCiSigningKeys !== false) {
      const m = wf.match(CI_SIGNING_KEY);
      if (m) {
        findings.push({
          level: "high", file: rel.workflow, message: `feed/code signing key in CI: ${m[0]}`,
          hint: "sign the feed/runtime OFFLINE and upload via scripts/publish-feed.mjs — keys never enter CI",
        });
      }
    }

    return { status: findings.some((f) => f.level === "high") ? "fail" : findings.length ? "warn" : "pass", findings };
  },
};
