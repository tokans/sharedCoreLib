#!/usr/bin/env node
// sharedcorelib-publisher-ci — enforces the suite's security protocols at a consuming
// app's dev/CI stage. Zero runtime deps; Node built-ins only.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, CONFIG_FILE } from "../src/config.mjs";
import { readJson } from "../src/util.mjs";
import { CHECKS } from "../src/checks/index.mjs";
import { runAll, summarize, renderText } from "../src/runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      args.flags[k] = v ?? true;
    } else args._.push(a);
  }
  return args;
}

function cmdList() {
  console.log("\n  Available checks:\n");
  for (const c of CHECKS) console.log(`  · ${c.id.padEnd(20)} [${c.severity}]  ${c.title}`);
  console.log("");
}

function cmdInit(appDir, flags) {
  const templates = join(PKG_ROOT, "templates");
  const pkg = readJson(join(appDir, "package.json")) ?? {};
  const repoName = String(flags["repo-name"] ?? pkg.name ?? basename(appDir));
  const appId = String(flags["app-id"] ?? repoName).toLowerCase();
  const appName = String(flags["app-name"] ?? pkg.name ?? repoName);
  const publishOwner = String(flags["publish-owner"] ?? "tokans");

  // Identity tokens substituted at scaffold time. The per-release tokens in the pages
  // template (__VERSION__, __REPO__, __RELEASE_URL__, __LATEST_URL__) are intentionally
  // NOT in this map — the release workflow fills those at publish time.
  const tokens = {
    __APP_NAME__: appName, __APP_ID__: appId,
    __PUBLISH_OWNER__: publishOwner, __REPO_NAME__: repoName,
  };

  const writeIfAbsent = (from, to) => {
    const dest = join(appDir, to);
    if (existsSync(dest)) { console.log(`  skip ${to} (exists)`); return; }
    let content = readFileSync(join(templates, from), "utf8");
    for (const [k, v] of Object.entries(tokens)) content = content.split(k).join(v);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    console.log(`  wrote ${to}`);
  };

  // Security config + gate.
  writeIfAbsent("sharedcorelib.security.json", CONFIG_FILE);
  writeIfAbsent("publisher.trust.json", "publisher.trust.json");
  writeIfAbsent("release.signing.json", "release.signing.json");
  writeIfAbsent("deprecations.json", "deprecations.json");
  writeIfAbsent("schema.manifest.json", "schema.manifest.json");
  writeIfAbsent("github-actions.yml", ".github/workflows/security.yml");

  // Cross-account release pipeline (publish builds + gh-pages to the publisher account).
  writeIfAbsent("release/release.yml", ".github/workflows/release.yml");
  writeIfAbsent("release/pages/index.template.html", ".github/pages/index.template.html");
  writeIfAbsent("release/scripts/deploy.mjs", "scripts/deploy.mjs");
  writeIfAbsent("release/scripts/publish-feed.mjs", "scripts/publish-feed.mjs");
  writeIfAbsent("release/scripts/build-masters-feed.mjs", "scripts/build-masters-feed.mjs");
  writeIfAbsent("release/masters.feed.example.json", "masters.feed.example.json");
  writeIfAbsent("release/scripts/launch-campaign.mjs", "scripts/launch-campaign.mjs");
  // Vendored growth-campaign-loop scripts (stdlib Python) so CI + the human share tooling.
  for (const f of ["utm_builder.py", "metrics_tracker.py", "experiment_scorecard.py", "outreach_mailmerge.py", "README.md"]) {
    writeIfAbsent(`release/scripts/campaign/${f}`, `scripts/campaign/${f}`);
  }

  console.log(`
  Scaffolded for "${appName}" → publisher repo ${publishOwner}/${repoName}.

  Next:
    1. Fill publisher.trust.json with your real baked keys.
    2. Create the publisher repo ${publishOwner}/${repoName} and add a SOURCE-repo
       secret PUBLISH_TOKEN (a PAT with contents:write on it).
    3. One-time: enable Pages on ${publishOwner}/${repoName} (Settings → Pages →
       gh-pages / root) → site at https://${publishOwner}.github.io/${repoName}/
    4. npx sharedcorelib-publisher-ci check    # gate must pass
    5. node scripts/deploy.mjs v0.1.0          # tag + push → builds & publishes

  Masters OTA feed (the daily-updated reference data):
    a. Copy masters.feed.example.json → masters.feed.json and fill in your masters
       (bump \`revision\` on every publish — anti-downgrade).
    b. OFFLINE, with the secret keys mounted:
         MASTERS_SIGNING_KEY_FILE=… MASTERS_TRANSPORT_KEY_FILE=… \\
           node scripts/build-masters-feed.mjs masters.feed.json ./dist-suite
    c. node scripts/publish-feed.mjs ./dist-suite   # uploads to the feed baseUrl
`);
}

async function cmdCheck(appDir, flags) {
  let loaded;
  try { loaded = loadConfig(appDir); }
  catch (e) { console.error(`  config error: ${e.message}`); process.exit(2); }

  const { config } = loaded;
  if (flags["fail-on"]) config.failOn = flags["fail-on"];

  const skip = new Set(config.skipChecks ?? []);
  const active = CHECKS.filter((c) => !skip.has(c.id));
  const results = await runAll({ appDir, config }, active);
  const summary = summarize(results, config.failOn);

  if (flags.json) {
    console.log(JSON.stringify({ results, summary, failOn: config.failOn }, null, 2));
  } else {
    console.log(renderText(results, summary, config.failOn));
  }
  process.exit(summary.failed ? 1 : 0);
}

const HELP = `
  sharedcorelib-publisher-ci <command> [options]

  Commands:
    check            Run all security checks (default)
    init             Scaffold config + trust manifest + CI workflow into this app
    list             List the available checks
    help             Show this help

  Options:
    --dir=<path>     App directory to check (default: cwd)
    --fail-on=<lvl>  Threshold that fails the build: critical|high|medium|low
    --json           Machine-readable output
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? "check";
  const appDir = resolve(args.flags.dir ? String(args.flags.dir) : process.cwd());

  switch (cmd) {
    case "list": return cmdList();
    case "init": return cmdInit(appDir, args.flags);
    case "help": case "--help": case "-h": return console.log(HELP);
    case "check": return cmdCheck(appDir, args.flags);
    default:
      console.error(`  unknown command: ${cmd}`);
      console.log(HELP);
      process.exit(2);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
