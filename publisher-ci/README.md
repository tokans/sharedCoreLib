# sharedcorelib-publisher-ci

A **dev-only** CI/CD toolkit that enforces the suite's security protocols at *each
consuming app's* build stage, so every publisher app stays aligned with
[`../THREAT_MODEL.md`](../THREAT_MODEL.md). It is a **separate package** that is **never
bundled into the downloadable runtime** — apps add it as a `devDependency` and run it in
CI; it ships no code into `dist/`.

Zero runtime dependencies (Node ≥18 built-ins only), so it adds nothing to an app's
install graph beyond itself.

## Why it exists

The shared runtime is downloaded and hot-reloaded as **executable code** across every
installed app, so a drift in any one app's security posture (a weak KDF, an unpinned
dependency, a missing anti-rollback metadata config, a non-baked trust anchor) weakens
the whole suite. This toolkit makes those protocols a **build gate** instead of a
code-review hope.

## Install & wire up (in a consuming app)

```jsonc
// app/package.json
"devDependencies": { "sharedcorelib-publisher-ci": "file:../sharedCoreLib/publisher-ci" }
```

```bash
npx sharedcorelib-publisher-ci init    # scaffolds config + trust manifest + CI workflow
npx sharedcorelib-publisher-ci check   # runs the gate; exit 1 on findings ≥ threshold
```

`init` writes (skipping any that exist):

- `sharedcorelib.security.json` — the policy/thresholds for this app
- `publisher.trust.json` — the **baked** trust anchor (fill in real keys)
- `release.signing.json` — the updater metadata policy
- `deprecations.json` — the deprecated-API ledger (lib publisher maintains)
- `.github/workflows/security.yml` — the CI gate
- `.github/workflows/release.yml` — cross-account build + release + gh-pages publish
- `.github/pages/index.template.html` — the gh-pages landing page (editable)
- `scripts/deploy.mjs` — tag + push to fire a release
- `scripts/publish-feed.mjs` — upload the **offline-signed** suite feed
- `scripts/launch-campaign.mjs` — build a growth-campaign brief on publish
- `scripts/campaign/*.py` — the four vendored `growth-campaign-loop` scripts (UTM/metrics/scorecard/mailmerge)

Identity tokens (`__APP_NAME__`/`__REPO_NAME__`/`__PUBLISH_OWNER__`) are filled from your
`package.json` name; override with `--app-name`, `--repo-name`, `--publish-owner` (default
owner `tokans`). The per-release tokens in the pages template are left for the workflow.

### Cross-account publishing

Source lives in the dev account; **builds, releases, and the gh-pages site publish to a
separate publisher account** (`tokans`) under a repo matching the source name — the
myFinance precedent. The release workflow uses the source-repo secret **`PUBLISH_TOKEN`**
(a PAT with `contents: write` on the publisher repo; `GITHUB_TOKEN` can't write
cross-account). Feed/runtime signing is done **offline** via `publish-feed.mjs` — keys
never enter CI (THREAT_MODEL §2), which `release-pipeline` enforces.

### Growth campaign on every publish

The release workflow's final `campaign` job **initiates a growth campaign** each time an
app is published. `launch-campaign.mjs` calls the **vendored `growth-campaign-loop`
scripts** (`scripts/campaign/utm_builder.py` + `metrics_tracker.py`) to build UTM-tracked
links to the **live gh-pages landing page** and a `metrics.csv` baseline, plus a brief whose
launch creative is the **myDemo** asset published to the site — then CI files a *"Growth
campaign: &lt;app&gt; &lt;version&gt;"* issue on the source repo. A human runs the
`growth-campaign-loop` skill from that issue to execute Phases 3-5 (posting, outreach,
assess via `experiment_scorecard.py`, iterate) — the parts that must stay human. So every
release auto-seeds a fresh, measurable cycle whose creative + destination are the demo +
site you just published. (No Python in CI → `launch-campaign.mjs` falls back to inline links.)

## Commands

| Command | Effect |
|---|---|
| `check` (default) | Run all checks; exit `1` if any finding is at/above `failOn` (default `high`), else `0` |
| `init` | Scaffold config, trust manifest, signing config, and CI workflow |
| `list` | List the checks |
| `help` | Usage |

Flags: `--dir=<path>` (default cwd), `--fail-on=critical|high|medium|low`, `--json`.

## Checks

| id | Severity | Enforces (THREAT_MODEL.md) |
|---|---|---|
| `trust-anchor` | critical | §2/§3 — root is **baked, immutable, offline**, feed is HTTPS + `anchorSource:"baked"`, new-app onboarding chains to root |
| `key-separation` | critical | §2 — **code ≠ data ≠ root** keys, all root-delegated, code role has a k-of-n threshold |
| `update-metadata` | high | §3 — releases declare **monotonic version + anti-rollback + expiring timestamp** (+ optional transparency log) |
| `deprecation-window` | high | principle #6 — no API removed before its 3-version window elapses (validates `deprecations.json`) |
| `kdf-floor` | high | §5 — PBKDF2 **≥600k** (or Argon2id), CSPRNG for secrets, versioned seal format |
| `tls-only` | high | §7 — **no plaintext `http://`** endpoints (localhost excepted) |
| `dependency-pinning` | medium | §8 — lockfile present + **critical deps exactly pinned** |
| `release-pipeline` | high | cross-account publish uses **`PUBLISH_TOKEN`**, targets the publisher account, and carries **no feed/code signing keys in CI** (signing is offline) |

## Configuration (`sharedcorelib.security.json`)

```jsonc
{
  "coreVersion": "1.0.0",          // shared-runtime version this app targets
  "deprecationWindow": 3,           // versions an API must stay after deprecation
  "trustManifest": "publisher.trust.json",
  "releaseSigning": "release.signing.json",
  "deprecations": "deprecations.json",
  "source": { "include": ["src", "src-tauri/src"], "ignore": [] },
  "kdf": { "minPbkdf2Iterations": 600000, "requireFormatHeader": true },
  "criticalDeps": ["sharedcorelib", "@noble/ed25519", "@tauri-apps/plugin-stronghold"],
  "feed": { "requireHttps": true },
  "failOn": "high"                  // threshold that fails the build
}
```

A JSON Schema for the trust manifest lives at [`schema/publisher.trust.schema.json`](schema/publisher.trust.schema.json).

## Scope & limits

- The source-scanning checks (`kdf-floor`, `tls-only`) are **high-signal heuristics**, not
  a substitute for review — they catch the common regressions (weak KDF constants,
  plaintext URLs, `Math.random` for secrets) but a determined obfuscation can evade a
  regex. Runtime controls (verify-at-load, quiesce/lock-on-swap, native-owned update
  confirmation) are enforced by **code review of the `sharedcorelib/suite` implementation**,
  not by this static gate — see the control→enforcement map in `THREAT_MODEL.md` §9.
- `init`-scaffolded `publisher.trust.json` ships **placeholder** keys; the gate fails until
  real offline-root + delegated keys are filled in.

## Self-test

```bash
npm run selftest    # runs the gate against fixtures/passing (expects PASS / exit 0)
```
