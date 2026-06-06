#!/usr/bin/env node
// launch-campaign.mjs — on every publish, assemble the deterministic Phase 1-2 inputs for
// the `growth-campaign-loop` skill, using the **myDemo creative** + the **gh-pages site**:
//   - UTM-tracked links to the live landing page (via the vendored utm_builder.py),
//   - a metrics.csv baseline (via metrics_tracker.py),
//   - a campaign brief whose launch creative is the demo asset published to gh-pages.
// CI then files an issue to INITIATE the loop; a human runs the growth-campaign-loop skill
// from there (Phases 3-5: execute → assess → improve — the parts that must stay human).
//
//   node scripts/launch-campaign.mjs            # uses env from the release workflow
// Env: VERSION, APP_NAME, PUBLISH_REPO, PAGES_URL, DEMO_ASSET (default assets/demo.mp4)
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const env = process.env;
const version = env.VERSION || "v0.0.0";
const repo = env.PUBLISH_REPO || "__PUBLISH_OWNER__/__REPO_NAME__";
const appName = env.APP_NAME || "__APP_NAME__";
const pagesUrl = (env.PAGES_URL || "https://__PUBLISH_OWNER__.github.io/__REPO_NAME__/").replace(/\/+$/, "/");
const demoAsset = env.DEMO_ASSET || "assets/demo.mp4";
const releaseUrl = `https://github.com/${repo}/releases/tag/${version}`;

let tagline = "";
try { tagline = JSON.parse(readFileSync("package.json", "utf8").replace(/^﻿/, "")).description || ""; } catch {}

const slug = `${appName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${version}`;
const outDir = join("campaign", version);
mkdirSync(outDir, { recursive: true });

// Default channels as `source,medium,content` (matches utm_builder.py's --channel format).
const channels = [
  "reddit,community,problem_post",
  "hackernews,community,show_hn",
  "twitter,social,launch_thread",
  "newsletter,email,announce",
  "producthunt,referral,launch",
];

// Locate Python and the vendored growth-campaign-loop scripts.
const SCRIPTS = join("scripts", "campaign");
function findPython() {
  for (const bin of ["python3", "python"]) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return bin;
  }
  return null;
}
const py = findPython();
const haveScripts = existsSync(join(SCRIPTS, "utm_builder.py"));

let linksMd = "";
let usedRealScripts = false;

if (py && haveScripts) {
  // Phase-2 tracked links via the real utm_builder.py (writes a CSV + prints a markdown table).
  const args = [join(SCRIPTS, "utm_builder.py"), "--base-url", pagesUrl, "--campaign", slug,
    "--csv", join(outDir, "links.csv")];
  for (const c of channels) args.push("--channel", c);
  const r = spawnSync(py, args, { encoding: "utf8" });
  if (r.status === 0) {
    linksMd = (r.stdout || "").trim();
    usedRealScripts = true;
  }
  // Seed the metrics baseline via metrics_tracker.py.
  spawnSync(py, [join(SCRIPTS, "metrics_tracker.py"), "log", "--file", join(outDir, "metrics.csv"),
    "visitors=0", "signups=0", "donors=0", "stars=0"], { encoding: "utf8" });
}

if (!usedRealScripts) {
  // Fallback (no Python / scripts absent): inline UTM links + a metrics header.
  const mk = (spec) => {
    const [source, medium = "referral", content = ""] = spec.split(",");
    const q = `utm_source=${source}&utm_medium=${medium}&utm_campaign=${slug}${content ? `&utm_content=${content}` : ""}`;
    return { source, url: `${pagesUrl}?${q}` };
  };
  const links = channels.map(mk);
  writeFileSync(join(outDir, "links.json"), JSON.stringify(links, null, 2));
  if (!existsSync(join(outDir, "metrics.csv"))) {
    writeFileSync(join(outDir, "metrics.csv"), "date,visitors,signups,donors,stars\n");
  }
  linksMd = links.map((l) => `- **${l.source}:** ${l.url}`).join("\n");
}

const brief = `# Growth campaign — ${appName} ${version}

> Auto-initiated by CI on publish to \`${repo}\`. **Run the \`growth-campaign-loop\` skill
> against this brief** to execute (Phases 3-5). CI has done the deterministic Phase 1-2 setup
> ${usedRealScripts ? "with the vendored growth-campaign-loop scripts." : "(inline fallback — Python/scripts not found in CI)."}

## Product (Phase 1)
- **What:** ${appName}${tagline ? ` — ${tagline}` : ""}
- **Landing page (gh-pages):** ${pagesUrl}
- **Latest release:** ${releaseUrl}
- **Launch creative (myDemo):** ${pagesUrl}${demoAsset} — the recorded feature demo, refreshed this publish.
- **Goal:** _set a measurable target + deadline (e.g. "200 signups in 6 weeks")._
- **Baseline:** _fill from analytics; logged in \`campaign/${version}/metrics.csv\`._

## Tracked links (Phase 2)
${linksMd}

## Next (run the skill)
1. \`growth-campaign-loop\` Phase 2 — pick 2-3 channels, write hypotheses, pin the timeline.
2. Phase 3 — execute: post with the demo creative; outreach via \`scripts/campaign/outreach_mailmerge.py\`.
3. Phase 4 — \`scripts/campaign/metrics_tracker.py report\` + \`experiment_scorecard.py\` against the goal.
4. Phase 5 — double-down / iterate / cut, then loop.

_Creative + destination are regenerated every publish, so each release seeds a fresh cycle._
`;
writeFileSync(join(outDir, "brief.md"), brief);
console.log(`campaign brief → ${join(outDir, "brief.md")}${usedRealScripts ? " (utm_builder.py + metrics_tracker.py)" : " (inline fallback)"}`);
