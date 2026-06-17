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

// Sanity: at least one signed feed must be present (the updater verifies these), and
// every metadata file must carry its detached `.sig`. The suite TUF feed and the
// standalone masters feed (build-masters-feed.mjs) can ship together or on their own.
const has = (f) => existsSync(join(feedDir, f));
const hasSuite = ["suite.snapshot.json", "suite.snapshot.json.sig", "suite.timestamp.json", "suite.timestamp.json.sig"].every(has);
const hasMasters = has("masters.manifest.json") && has("masters.manifest.json.sig");
if (!hasSuite && !hasMasters) {
  die("no signed feed found — expected the suite TUF metadata and/or masters.manifest.json (+ .sig). Build + sign offline first.");
}
for (const meta of ["suite.snapshot.json", "suite.timestamp.json", "masters.manifest.json"]) {
  if (has(meta) && !has(`${meta}.sig`)) die(`missing signature: ${meta}.sig (sign offline before publishing)`);
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
