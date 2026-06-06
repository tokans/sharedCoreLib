#!/usr/bin/env node
// deploy.mjs — tag the current commit and push it, firing .github/workflows/release.yml,
// which builds and publishes to the publisher account (__PUBLISH_OWNER__/__REPO_NAME__).
// Cross-platform port of the myFinance deploy.bat precedent.
//
//   node scripts/deploy.mjs v0.1.0
import { execFileSync } from "node:child_process";

const version = process.argv[2];
const run = (args, opts = {}) => execFileSync("git", args, { stdio: "pipe", encoding: "utf8", ...opts }).trim();
const die = (m) => { console.error(`ERROR: ${m}`); process.exit(1); };

if (!version) die("provide a version, e.g. node scripts/deploy.mjs v0.1.0");
if (!/^v\d+\.\d+\.\d+$/.test(version)) die(`version must look like v1.2.3 (got "${version}")`);

try { run(["rev-parse", "--is-inside-work-tree"]); } catch { die("not a git repository"); }

try { run(["diff", "--quiet"]); }
catch { console.warn("WARNING: uncommitted changes — the tag points at the last commit, not your working tree."); }

try { run(["rev-parse", version]); die(`tag ${version} already exists`); } catch { /* good: tag is free */ }

console.log(`Tagging ${version} and pushing…`);
try { run(["tag", version]); } catch (e) { die(`failed to create tag: ${e.message}`); }
try { run(["push", "origin", version]); }
catch (e) { try { run(["tag", "-d", version]); } catch {} die(`failed to push tag: ${e.message}`); }

console.log(`Done. Release ${version} is building.`);
console.log("Result lands at: https://github.com/__PUBLISH_OWNER__/__REPO_NAME__/releases");
