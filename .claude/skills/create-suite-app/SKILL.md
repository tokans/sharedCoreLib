---
name: create-suite-app
description: >-
  Guide an app creator end-to-end through building a new local-first Tauri + React app on top of
  `sharedcorelib` — from a raw idea to a shipped, demoed, tested app. Run a structured elaboration
  interview (idea → users → features), design the user-tier ladder and feature-gating, map reference
  masters and reminders, then produce a PRIORITIZED step-by-step implementation plan, scaffold the app
  with the shared-lib config + `publisher-ci` security gate, write unit + e2e tests, and record a demo
  of EACH feature with the `@mydemo/core` rig in C:\workspace\myDemo — running each demo, capturing the
  screen, and fixing issues found. ALWAYS use this skill whenever the user wants to start, scaffold,
  build, or plan a new app in this suite (myFinance/myHealth-style), mentions "new app on the shared
  lib", "use sharedcorelib", tiering/feature-gating/masters for an app, or wants demos+tests for app
  features — even if they don't name the skill explicitly.
---

# Create a suite app on sharedcorelib

You are taking an app creator from a rough idea to a working, tested, demoed local-first app that
consumes `sharedcorelib` (the shared runtime: vault, masters/OTA, tiers, gating, reminders, sync,
report, ice, suite-updater) and is recorded with `@mydemo/core`. The shared lib gives you the
mechanisms; the app owns its schema, domain, pages, branding, and the *config* it injects.

**Read these first** (they are the contracts you must honor):
- `C:\workspace\sharedCoreLib\README.md` — the 12 subsystems + masters + suite architecture.
- `C:\workspace\sharedCoreLib\CONTRACT.md` — per-subsystem app-config shape + what stays in-app.
- `C:\workspace\sharedCoreLib\THREAT_MODEL.md` — the security protocols the app must satisfy.
- `C:\workspace\myDemo\SKILL.md` — how to author + record a feature demo.

Work through the stages in order. **Do not skip to implementation** — the value is in the elaboration
and the prioritized plan. Confirm with the user at each stage gate before moving on.

---

## Stage 0 — Orient

Confirm the workspace: `sharedCoreLib`, `myDemo`, and the sibling app dir all live under
`C:\workspace\`. Decide the app's short id (lowercase, e.g. `myhealth`) and human name — you will use
the id as the master scope (`<appId>:…`) and the vault `clientName`. Capture the one-sentence premise.

## Stage 1 — Elaborate the idea (interview)

Drive a focused interview. Ask in small batches, reflect answers back, and keep a running
`docs/app-brief.md` in the app repo. Cover:

1. **Premise & outcome** — what does a user achieve? What is the single "aha" moment?
2. **Users & contexts** — who, on what device (desktop-first? mobile?), how often, online or offline?
3. **Core entities** — the 3–7 nouns the app revolves around (these become SQLite tables + masters).
4. **Jobs-to-be-done** — the top 5–10 things a user does, as verbs. These become **features**.
5. **Non-goals** — what it deliberately won't do (keeps scope honest).
6. **Hard constraints to preserve** (from the suite): receive-only network, no LLM in product logic,
   append-only migrations, per-app vault salt that never changes.

Output of this stage: a confirmed feature list (verbs) and entity list (nouns).

## Stage 2 — User tiers (engagement ladder)

Design the app's **tier ladder** (consumed by `sharedcorelib/tiers`). Tiers are app-specific data;
the resolution mechanism is shared. With the user, define an ordered low→high ladder. For each tier:
`{ key, label, criteria, reached(ctx), grant? }`. Guide the design:

- The **base tier** is always reached (the floor). Earned tiers add a `reached(ctx)` predicate over an
  app-defined context (e.g. distinct active days, records created, a milestone).
- **Patron and Partner are the standard top two tiers for EVERY suite app — do NOT redesign them.**
  Build only the **earned** ladder, then append the shared grant tiers:
  `const TIERS = [...earnedTiers, ...decorate(standardTopTiers<Ctx>())]` (`standardTopTiers` from
  `sharedcorelib/tiers`; add only icon/colour). The app's `TierCtx` must extend `PatronPartnerCtx`
  (`{ isPatron, isPartner }`), fed from the grant state (Stage 4 / `sharedcorelib/grant`).
- **"Become a Patron"** appears once the user reaches the **2nd earned tier** (`becomePatronVisible`)
  and a Patron gets **instant access to all features** (wire `hasPatronAccess` into gating's `override`,
  Stage 3). **Partner** outranks Patron and is activated by enrolling at tokans.org.
- Keep display (icon/colour) on the app's tier objects; the lib preserves the richer type.

Ask: "What should make a user feel they've *graduated*?" Map 2–4 **earned** tiers (Patron/Partner come
from the lib). Record the ladder and the `TierCtx` shape (distinct-day counts, etc.) extending `PatronPartnerCtx`.

## Stage 3 — Feature gating

Decide which features are **progressively unlocked** (consumed by `sharedcorelib/gating`). For each
gated feature define a `FeatureGate<TFlags>`: `{ key, isUnlocked(flags), lockedTitle, unlockHint,
ctaLabel, ctaTo? }`. Then define:

- `TFlags` — the app's flag shape (booleans/counts the gates read).
- `computeFlags()` — how flags are derived from the app's own SQLite (only runs inside Tauri).
- `unlockedAll` — the all-unlocked flags used in a browser/dev preview so previews aren't locked.
- `override` — pass `() => hasPatronAccess(tierCtx)` so a **Patron/Partner unlocks every feature**.

Cross-check tiers ↔ gates: a gate may be "unlocked at tier X". Keep the **locked-state UI**
(`FeatureGuard`, routing, unlock-in-place dialogs) in the app — only the gate framework + store are
shared. Record the gate table: feature → predicate → unlock hint.

## Stage 4 — Masters, reminders, reports, ICE, sync (pick what applies)

For each shared subsystem the app uses, capture the app-supplied config (see CONTRACT.md):

- **Masters** — list the app's reference sets. Reuse the **common** masters (`country`, `city`,
  `currency`, `relationship`) via `getCommonBaked` instead of redefining them; declare app-specific
  masters under the `<appId>:` scope. Decide which are baked vs OTA-delivered. Note the OTA
  `baseUrl`/keys come from the publisher trust anchor (Stage 7).
- **Reminders** — list derived-reminder generators (the domain rules that emit due dates) + the DB
  adapters (`syncDerived`/`listOpen`/`markFired`). The scheduling math is shared.
- **Report** — which printable artifacts exist (HTML templates the app owns; printing is shared).
- **ICE** — does the app carry emergency-contact data? If so, define the card fields + disclaimer.
- **Sync** — does it sync device-to-device? If yes, capture the table SPEC; the LWW kernel + envelope
  crypto are shared, the merge engine + transport stay in-app.
- **Patron/Partner entitlement** (`sharedcorelib/grant`) — wire the **receive-only** handoff that sets
  `isPatron`/`isPartner` (feeds the tier ctx + gating override). Configure the **grant signing keys**
  (separate from masters), `parsePayload`, and the channels: `readDroppedFile` (a `.grant` saved to
  Downloads) and/or `fetchByToken` (the user pastes an **anonymous** donation/enrollment reference — a
  GET, never an upload). Persist the resulting status locally. Donation happens on tokans.org; Partner
  enrollment collects details on the portal — the app only *receives* the status.

## Stage 5 — Prioritized implementation plan

Synthesize Stages 1–4 into a **prioritized, step-by-step plan** in `docs/plan.md`. Rules:

- Order by **dependency then value**: schema/migrations → shared-lib config injection → first
  end-to-end feature (the "aha") → gating/tiers wiring → remaining features by value → reminders/report
  → sync → polish.
- Each step is shippable and testable on its own, and names: the files touched, the shared subsystem(s)
  used, the unit + e2e tests to write, and the demo scenario to record.
- Mark an **MVP cut line** — the smallest set that delivers the aha moment.
- Surface risks/unknowns explicitly (a step may be "spike X first").

Present the plan and get sign-off before writing code. This plan is the spine for the rest.

## Stage 6 — Scaffold the app

Create the app repo as a sibling (`C:\workspace\<appId>`). Wire the shared lib per CONTRACT.md §1:

- `package.json`: `"sharedcorelib": "file:../sharedCoreLib"`, a `prebuild` that builds the lib, and a
  `devDependency` on `"@mydemo/core": "file:../myDemo"`.
- `tsconfig.json`: `"moduleResolution": "Bundler"` + `skipLibCheck: true`.
- Write the **single app-config** module that injects every subsystem's config (vault `clientName`/
  `snapshotFile`, masters registry+schemas, the tier ladder, gate defs + `computeFlags`, reminder
  generators+adapters, report templates, ICE fields, sync SPEC). Call the core factories with it.
- `src-tauri`: thin shell — copy `core_bootstrap.rs` (set `APP_ID`), call `ensure_shared_core`, register
  `shared_core_masters_dir`, and **set the per-app Argon2 salt in `lib.rs` (never change it later)**.
- App shell: render `SupportedByTokans` from `sharedcorelib/ui` in the **bottom status bar** (every suite
  app shows the same "Supported by Tokans.org" line) — pass the app's `className` and a Tauri `onActivate`
  opener so the link opens in the browser, not the webview. See checklists.md → Stage 6 skeleton.

## Stage 7 — Security gate (publisher-ci)

Add `"sharedcorelib-publisher-ci": "file:../sharedCoreLib/publisher-ci"` as a `devDependency`, then:

```bash
npx sharedcorelib-publisher-ci init     # scaffolds publisher.trust.json + release.signing.json + CI gate
npx sharedcorelib-publisher-ci check    # must pass before the app is "done"
```

Fill `publisher.trust.json` with the app's real **baked** trust anchor (offline root + delegated
data/code/snapshot/timestamp keys per THREAT_MODEL §2). Make `check` a required CI step. Re-run it after
each feature — it enforces KDF floor, TLS-only, dependency pinning, anti-rollback metadata, and the
3-version deprecation window.

## Stage 7b — Release & distribution (publish to the publisher account)

Suite apps keep **source** in the dev account but publish **builds, releases, and a
gh-pages site** to a separate **publisher account** (`tokans`) under a repo whose name
matches the source repo (e.g. source `anshumandas/myhealth` → publisher `tokans/myhealth`).
This is the myFinance precedent — read its `release.yml` / `deploy.bat` / `publish-masters.bat`
for context. `publisher-ci init` already scaffolded the pipeline:

- `.github/workflows/release.yml` — on a `v*` tag (or manual dispatch): runs the security
  gate, builds Windows/macOS Tauri bundles, then a `publish` job uses the **`PUBLISH_TOKEN`**
  secret to `gh release create --repo tokans/<repo>`, regenerate the destination README, and
  push a landing page to the **gh-pages** branch from `.github/pages/index.template.html`.
- `scripts/deploy.mjs` — `node scripts/deploy.mjs v0.1.0` tags + pushes (fires the workflow).
- `scripts/publish-feed.mjs` — uploads the **offline-signed** suite feed (the `baseUrl` the
  updater fetches) to a rolling release. **Signing keys never enter CI** (THREAT_MODEL §2).
- `scripts/launch-campaign.mjs` + the workflow's `campaign` job — on every publish, **initiate
  a growth campaign**: UTM links to the gh-pages site + a metrics baseline + a brief whose
  creative is the **myDemo** asset, then file a *"Growth campaign: &lt;app&gt; &lt;version&gt;"*
  issue. Run the **`growth-campaign-loop`** skill from that issue to execute/measure/iterate
  (Phases 3-5 stay human). Ensure a demo asset (e.g. `assets/demo.mp4` from Stage 9) is in
  `.github/pages/assets/` so it ships to the site as the campaign creative.

Set up once: create `tokans/<repo>`, add the source-repo secret **`PUBLISH_TOKEN`** (a PAT
with `contents: write` on the publisher repo — the built-in `GITHUB_TOKEN` can't write
cross-account), and enable Pages (Settings → Pages → gh-pages / root). Point the suite
updater's `baseUrl` at the publisher repo's feed release. The `release-pipeline` check
fails the build if the workflow lacks `PUBLISH_TOKEN`, targets the wrong account, or leaks
a feed/code signing key into CI.

## Stage 7c — Mount the suite marketplace (the "More" surface)

Every suite app exposes a built-in **app marketplace** so users discover and manage the whole
suite from inside any app — a store-like icon placed under **"More"** on mobile. Mount
`createAppCatalog(config)` from `sharedcorelib/suite` and render its rows (`list()` /
`listInstalled()` / `listAvailable()`):

- **Installed apps** show an **installed badge** and **open/launch** on click (`activate` →
  `open` → your injected `launchApp`, e.g. a `myhealth://` deep-link / OS launch).
- **Not-installed apps** **download** on click (`activate` → `install` → `openExternal` the
  platform installer link; the OS installs and the new app's bootstrap marks it installed).
- Each row's `primaryAction` (`open`/`download`/`current`) tells the UI which icon + behavior
  to render; `updateAvailable` flags an installed app with a newer published version.

Inject `currentAppId`, the registry reader (`listPublishedApps`), per-app-private
`getLocalState`/`setLocalState`, native `openExternal` + `launchApp`, and `entitlements`
(the Patron/Partner state from Stage 4). Allow-list feed-supplied `downloadLinks`/`marketingUrl`
origins before opening. Add a `data-testid` to the marketplace icon + rows so it gets an e2e test
and a demo (Stage 9).

**Access-gated apps.** A `PublishedApp` may set `access: "patron" | "partner"` and `hasBackend`. For a
gated app the user isn't entitled to, the row's `primaryAction` is **`enroll`** and `activate` routes
to the donation / partner-enrollment flow (`enrollUrl`). The flagship example is **myWorkAssistant**
(`access: "partner"`, `hasBackend: true`) — the one suite app with a **full backend + auth** built on
the **`/tauri-react-stack`** *and* this core lib. It behaves differently from every other app: the
marketplace shows **Enroll / Sign in** rather than a plain download, and it does **not** carry the
receive-only promise (it's a professional tool). Don't build myWorkAssistant with this skill's
local-first assumptions — use the tauri-react-stack skill for its backend/auth/real-time parts and this
core only for the shared mechanisms (vault, masters, tiers, marketplace).

## Stage 8 — Implement features (per the plan)

Work the plan step by step. For each feature: implement → write its **unit tests** (pure logic: tier
predicates, gate predicates, reminder generators, merge rules — these are deterministic and the most
valuable) → write its **e2e test** (drive the built app through the user flow) → then demo (Stage 9).
Keep migrations append-only. Add a stable `data-testid` to every element a demo or e2e test will touch.

## Stage 9 — Demo each feature (myDemo) + screenshot-and-fix loop

For EVERY feature, record a demo with `@mydemo/core` (read `C:\workspace\myDemo\SKILL.md` for the full
authoring rules). The loop:

1. Ensure the app has `demo/config.ts` (`defineConfig`, Tauri driver), `demo/record.ts`, and a
   `demo/scenarios/index.ts` registry. Set the demo-mode flag (`VITE_DEMO_MODE`) so the vault
   auto-unlocks and dialogs are deterministic (the demo-mode contract).
2. Write `demo/scenarios/NN-<feature>.ts` using ONLY the `Helpers` API and the app's real
   `data-testid`s and routes. Heavy seeding goes in `setup()`, the on-camera flow in `run()`.
3. **Record:** `npm run demo:single -- NN-<feature>`.
4. **Capture the screen / open the result:** read the produced `demo/output/NN-<feature>.gif` as an
   image and confirm it shows the intended flow.
5. **Fix issues found while running the demo** — blank/early-stop/too-fast means adjust waits/pacing
   and re-record; a missing `data-testid` or a blocking dialog/lock screen is an **app fix** (add the
   test-id, or gate the dialog behind the demo flag), not an engine hack. Re-run until the GIF rests on
   the feature's payoff screen. Capture any real bug the demo surfaces back into a fix + a regression test.

Record a demo for the **suite marketplace** too: open "More" → the marketplace → show an installed
app launching and a not-installed app starting a download.

This is **live testing**, not just marketing: the demo drives the *real* built app, so it surfaces
real bugs (a broken route, an unguarded dialog, a missing test-id, a feature that silently fails).
Treat every demo run as a test — when it breaks, fix the app and re-record; don't paper over it.

A feature is "done" only when: unit + e2e tests pass, `publisher-ci check` is green, and its demo GIF
clearly shows the flow.

## Stage 10 — Wrap up

Summarize: features shipped, tier ladder, gate table, masters used, the demo GIFs, test coverage, and
the green security gate. Note the MVP cut line vs what's beyond it, and the next-step backlog.

---

## Stage gates (don't bulldoze)

Confirm with the user at the end of each stage before proceeding: **idea → tiers → gates → subsystems →
plan → (sign-off) → scaffold → implement+test+demo per feature**. The elaboration and the prioritized
plan are where this skill earns its keep; the scaffolding and demos are mechanical once those are right.

## Reference

- `references/checklists.md` — the per-stage question bank, the app-config skeleton, and the
  "definition of done" checklist. Read it when you need the detailed prompts or the config template.
