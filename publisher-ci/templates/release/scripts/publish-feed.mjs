#!/usr/bin/env node
// publish-feed.mjs — upload the OFFLINE-SIGNED suite feed (masters + runtime + registry
// metadata and targets) to a rolling release on the publisher account. This is the
// `baseUrl` the suite updater (sharedcorelib/suite) fetches from.
//
// Signing happens OFFLINE, BEFORE this runs — the private keys NEVER touch CI (THREAT_MODEL §2).
// This script only uploads already-signed artifacts produced into the feed dir.
//
//   node scripts/publish-feed.mjs                 # uploads ./dist-suite to suite-latest
//   node scripts/publish-feed.mjs ./dist-suite suite-latest
//
// Requires: `gh` logged in to an account with write access to __PUBLISH_OWNER__/__REPO_NAME__.
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = "__PUBLISH_OWNER__/__REPO_NAME__";
const feedDir = process.argv[2] ?? "dist-suite";
const tag = process.argv[3] ?? "suite-latest";
const gh = (args) => execFileSync("gh", args, { stdio: "inherit" });
const die = (m) => { console.error(`ERROR: ${m}`); process.exit(1); };

if (!existsSync(feedDir)) die(`feed dir "${feedDir}" not found — build + sign the feed first`);
const files = readdirSync(feedDir).map((f) => join(feedDir, f));
if (!files.length) die(`feed dir "${feedDir}" is empty`);

// Sanity: signed metadata must be present (the updater verifies these).
for (const required of ["suite.snapshot.json", "suite.snapshot.json.sig", "suite.timestamp.json", "suite.timestamp.json.sig"]) {
  if (!existsSync(join(feedDir, required))) die(`missing signed metadata: ${required} (sign offline before publishing)`);
}

console.log(`Uploading feed (${files.length} files) to ${REPO} (${tag})…`);
try { execFileSync("gh", ["release", "view", tag, "--repo", REPO], { stdio: "ignore" }); }
catch {
  gh(["release", "create", tag, "--repo", REPO, "--title", "Suite feed",
      "--notes", "Rolling, offline-signed suite update feed. Updated on each publish.", ...files]);
  console.log(`Done. Feed published to https://github.com/${REPO}/releases/tag/${tag}`);
  process.exit(0);
}
gh(["release", "upload", tag, "--repo", REPO, "--clobber", ...files]);
console.log(`Done. Feed updated at https://github.com/${REPO}/releases/tag/${tag}`);
