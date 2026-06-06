# create-suite-app — question bank, config skeleton, definition of done

Read this when you need the detailed prompts for a stage, the app-config template, or the
done-checklist. The SKILL.md body has the flow; this file has the depth.

## Stage 1 question bank (elaboration)

- What's the one sentence you'd put on the landing page?
- Walk me through a user's first 5 minutes. Where's the payoff?
- What does the user have *before* they open the app (data they bring)? How do they get it in?
- What are the nouns you'd point at on a whiteboard? Which ones have many instances (→ tables) vs a
  fixed small set (→ masters)?
- What are the 10 verbs a power user does weekly?
- What would make you reject a feature request as "not this app"?
- Desktop-only, or phone too? Offline-first? Multi-device (→ sync)?
- Anything regulated/sensitive (→ vault, disclaimers, ICE)?

## Stage 2 — tier ladder template

```ts
interface TierCtx { distinctActiveDays: number; recordsCreated: number; /* app telemetry */ }
const TIERS: Array<TierDef<TierCtx> & { icon: string; colour: string }> = [
  { key: "newcomer", label: "Newcomer", criteria: "Just started", reached: () => true, icon: "🌱", colour: "..." },
  { key: "regular",  label: "Regular",  criteria: "Active 7+ days", reached: c => c.distinctActiveDays >= 7, icon: "⭐", colour: "..." },
  { key: "expert",   label: "Expert",   criteria: "Active 30+ days", reached: c => c.distinctActiveDays >= 30, icon: "🏆", colour: "..." },
  { key: "patron",   label: "Patron",   criteria: "Supports the project", reached: c => /* grant flag */ false, grant: true, icon: "💎", colour: "..." },
];
```

## Stage 3 — gate template

```ts
interface AppFlags { hasData: boolean; daysActive: number; importedOnce: boolean }
const GATES: FeatureGate<AppFlags>[] = [
  { key: "reports", isUnlocked: f => f.importedOnce, lockedTitle: "Reports", unlockHint: "Import data to unlock reports", ctaLabel: "Import", ctaTo: "/import" },
];
const unlockedAll: AppFlags = { hasData: true, daysActive: 999, importedOnce: true };
async function computeFlags(): Promise<Partial<AppFlags>> { /* query app SQLite */ return {}; }
```

## Stage 6 — app-config skeleton (the single injection point)

```ts
// src/coreConfig.ts — the ONE place the app wires the shared lib
import { createVault } from "sharedcorelib/vault";
import { createOtaUpdater, getCommonBaked } from "sharedcorelib/masters";
import { createGatingStore } from "sharedcorelib/gating";
// tiers/reminders/report/ice/sync imported where used

export const vault = createVault({ clientName: "<appId>", snapshotFile: "vault.stronghold" });

export const ota = createOtaUpdater({
  baseUrl: TRUST.feed.baseUrl, pubkeyHex: TRUST.delegations.data.publicKeyHex,
  transportKeyB64: "<...>", getLastRevision: async () => /* read app meta */ 0,
  applyEntry: async (e) => { /* upsert into app master_options under <appId>: scope */ },
});

export const gating = createGatingStore({ initialFlags, unlockedAll, computeFlags });
// + TIERS array, reminder generators+adapters, report templates, ICE fields, sync SPEC
```

Reuse common masters instead of shipping copies:
```ts
const countries = getCommonBaked("country");
const cities = getCommonBaked("city", selectedCountryCode);
```

## Stage 9 — demo config skeleton (Tauri driver)

```ts
// demo/config.ts
import { defineConfig } from "@mydemo/core";
export const config = defineConfig({
  rootDir: resolve(demoDir, ".."), demoDir,
  app: { windowTitle: "<App Name>", identifier: "com.<appId>.app", binName: "<appId>" },
  devUrl: "http://localhost:1420/",
  navAnchor: "nav-home",                          // test-id proving UI booted
  build: { frontendEnv: { VITE_DEMO_MODE: "1" } },// auto-unlock vault, deterministic dialogs
  resetFiles: ["app.db", "app.db-wal", "vault.stronghold"],
});
```

## Definition of done (per feature)

- [ ] Implemented per the plan step; migrations append-only.
- [ ] Unit tests for the pure logic (tier/gate predicates, reminder generators, merge rules).
- [ ] e2e test drives the real flow; every touched element has a stable `data-testid`.
- [ ] `npx sharedcorelib-publisher-ci check` is green.
- [ ] Demo scenario recorded; the GIF was opened/inspected and shows the flow resting on the payoff.
- [ ] Any bug the demo surfaced is fixed and covered by a regression test.

## Stage 7b — release pipeline checklist

`publisher-ci init` scaffolds these (identity tokens filled from your `package.json`
name; override with `--app-name` / `--repo-name` / `--publish-owner`, default owner `tokans`):

- [ ] `.github/workflows/release.yml` — `PUBLISH_REPO: tokans/<repo>`, builds on `v*` tag.
- [ ] `.github/pages/index.template.html` — landing page (edit freely; keep `__VERSION__`
      etc. for the workflow to fill at publish time).
- [ ] `scripts/deploy.mjs` (tag + push) and `scripts/publish-feed.mjs` (offline-signed feed upload).
- [ ] Publisher repo `tokans/<repo>` created; source-repo secret **`PUBLISH_TOKEN`** added
      (PAT, `contents: write` on the publisher repo).
- [ ] Pages enabled on `tokans/<repo>` (gh-pages / root) → `https://tokans.github.io/<repo>/`.
- [ ] Suite updater `baseUrl` points at the publisher repo's feed release.
- [ ] `release-pipeline` check green (PUBLISH_TOKEN present, correct owner, no signing keys in CI).

## Definition of done (whole app)

- [ ] `npm run build` + `npm run test` green; app builds & runs **standalone** (no sibling installed).
- [ ] Shared-core bootstrap (`ensure_shared_core`) wired; per-app Argon2 salt set and documented.
- [ ] Security gate green; trust anchor filled with real baked keys.
- [ ] `docs/app-brief.md` + `docs/plan.md` reflect what shipped (and the MVP cut line).
- [ ] Every feature has a demo GIF.
