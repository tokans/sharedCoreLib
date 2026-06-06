# Migration prompt — adopt the new `sharedcorelib`, delete duplicated features

Copy everything in the box below into a fresh agent session **with the target app repo
open** (e.g. `C:\workspace\myFinance`). It migrates an existing suite app onto the current
`sharedcorelib`, replacing app-local copies of now-shared mechanisms with lib imports and
**deleting the duplicated code**. It is conservative: app domain, pages, schema, and
branding stay; only the extracted mechanisms move.

---

```
You are migrating THIS app onto the latest `sharedcorelib` (at ../sharedCoreLib). Read
../sharedCoreLib/README.md, CONTRACT.md, and THREAT_MODEL.md first. Goal: every mechanism
that now lives in the shared lib is CONSUMED from the lib, and the app's duplicate
implementation is DELETED — while the app still builds, passes tests, runs standalone, and
keeps every existing user's data readable.

## Non-negotiables (do not break these)
- The vault's Argon2 salt/params in src-tauri/src/lib.rs MUST NOT change (changing them
  bricks existing vaults). Migrations stay append-only.
- Backward-compatible data: the lib's crypto/vault read LEGACY (pre-versioning) formats, so
  existing export packages and sealed blobs keep opening. Do not rewrite stored data.
- Standalone-first: the app must still build/run with no sibling installed.
- After each step run the build + tests; keep them green before moving on.

## Step 1 — Inventory
Find every app-local module that duplicates a shared subsystem. Map each to its lib subpath:
  - export/passphrase crypto            → `sharedcorelib/crypto`
  - Stronghold vault + blob sealing     → `sharedcorelib/vault`
  - masters verify + OTA + common sets  → `sharedcorelib/masters` (use `getCommonBaked` for
                                          country/city/currency/relationship; delete local copies)
  - engagement tiers                    → `sharedcorelib/tiers` (+ standard Patron/Partner tiers)
  - feature gating store                → `sharedcorelib/gating`
  - reminders scheduling/notify/sweep   → `sharedcorelib/reminders`
  - HTML→PDF report + escapeHtml        → `sharedcorelib/report`
  - ICE/contact extraction              → `sharedcorelib/ice`
  - sync LWW kernel + SyncDb            → `sharedcorelib/sync`
  - cn / class merge                    → `sharedcorelib/ui`
  - env detection                       → `sharedcorelib/env`
  - patron/donation file verification   → `sharedcorelib/grant`
Produce a table: app file → lib subpath → "replace & delete" or "keep (app-specific)".
List anything genuinely app-specific (domain logic, pages, schema, registries) as KEEP.

## Step 2 — Wire the dependency
Ensure package.json has `"sharedcorelib": "file:../sharedCoreLib"` and a `prebuild` that
builds the lib; tsconfig uses moduleResolution Bundler + skipLibCheck. Build the lib once.

## Step 3 — Replace + DELETE, one subsystem at a time
For each "replace & delete" row: swap the app's imports to the lib subpath, delete the local
module, and delete (or repoint) its unit tests — keep a thin test only where the app still
adds behavior on top. Specifics:
- **Tiers:** keep ONLY the app's earned tiers; build the ladder as
  `[...earnedTiers, ...decorate(standardTopTiers<Ctx>())]`. The tier context must extend
  `PatronPartnerCtx`. Remove any locally-defined Patron/Partner tier objects.
- **Patron/donation:** replace the local patron-file verify with `createGrantReceiver`
  (`sharedcorelib/grant`). Keep the app's persisted patron/partner STATE, but source
  `isPatron`/`isPartner` from the grant. ADD the receive-only backend token channel
  (`fetchByToken`) alongside the dropped-file channel so anonymous donors need no email.
- **Gating:** use `createGatingStore` and pass `override: () => hasPatronAccess(tierCtx)` so a
  Patron/Partner unlocks all features. Surface "Become a Patron" via `becomePatronVisible`.
- **Masters:** route verification through `sharedcorelib/masters`; delete the app's verify
  copy. Use `getCommonBaked` for the common sets and delete any duplicated seed JSON.
- **Crypto/vault:** import from the lib; delete local copies. Confirm a legacy round-trip
  test still passes (open a pre-migration package/blob).

## Step 4 — Adopt the NEW capabilities
- **Security gate:** add `sharedcorelib-publisher-ci` as a devDependency, run
  `npx sharedcorelib-publisher-ci init`, fill publisher.trust.json with REAL baked keys, and
  make `... check` a required CI step. Resolve every finding (KDF floor, TLS-only, pinning,
  anti-rollback metadata, release-pipeline). `init` also scaffolds the cross-account release
  pipeline (publish to tokans/<repo> + gh-pages) and the growth-campaign job.
- **Suite updater + marketplace:** wire `createSuiteUpdater` (daily receive-only check, native
  `confirmUpdate`) and mount `createAppCatalog` in the app's "More" surface (installed → open,
  available → download, Patron/Partner-gated → enroll). Inject `entitlements` from the grant.
- **Demos:** add `"@mydemo/core": "file:../myDemo"` and a `demo/` rig; record a demo per
  feature and use it for live testing + issue-fix (../myDemo/SKILL.md). Put a marketing
  demo at `.github/pages/assets/demo.mp4` so the gh-pages site + growth campaign use it.

## Step 5 — Verify (all must be green)
- `npm run build` + `npm run test` (incl. a legacy-format round-trip) + e2e.
- `npx sharedcorelib-publisher-ci check` — no findings at/above the threshold.
- Each feature's demo GIF recorded and inspected.
- Grep the repo for the deleted modules' names to confirm NO dangling imports remain, and
  that the app builds & runs standalone.

## Output
A short migration report: the inventory table, the files deleted, the lib subpaths now
consumed, any data-format compatibility notes, and the green build/test/gate/demote status.
Open a PR titled "Migrate to sharedcorelib <version>: consume shared mechanisms, delete duplicates".
```

---

## myFinance-specific appendix (concrete targets)

When the target is **myFinance**, these are the known duplicate modules to replace & delete
(verify against the live tree — some may have already been partially extracted):

| App file | → lib subpath | Action |
|---|---|---|
| `src/lib/gamification.ts` (Patron/Partner tier objects) | `sharedcorelib/tiers` `standardTopTiers` | keep earned tiers; spread standard top tiers; `TierContext extends PatronPartnerCtx` |
| `src/lib/patronFile.ts` | `sharedcorelib/grant` (`verifyGrant`/`createGrantReceiver`) | replace verify; add `fetchByToken` channel; delete local verify |
| `src/lib/patron.ts` | (keep state) sourced from `/grant` | keep persistence; source `isPatron`/`isPartner` from the grant |
| `src/masters/verify.ts` | `sharedcorelib/masters` | replace; delete local copy |
| `src/lib/featureGate.ts` | `sharedcorelib/gating` (`override` = `hasPatronAccess`) | replace store; Patron unlocks all |
| local export-crypto / vault helpers | `sharedcorelib/crypto` / `sharedcorelib/vault` | replace; delete; keep a legacy round-trip test |
| duplicated common-master seeds (cities/relationships) | `getCommonBaked` | delete the JSON; source from the lib |

KEEP (app-specific, do **not** move): the FIRE engine (`src/domain/fire*.ts`), estate/people
access tiers (`src/lib/accessTiers.ts` — unrelated "AccessTier" concept), ITR/tax, import,
report templates, pages, schema/migrations, branding.

> Note: myFinance's `accessTiers.ts` is the estate "who-sees-what" concept, NOT engagement
> tiers — leave it alone. Its `partners`/`PartnerPicker` are financial people, not the Partner
> TIER — also leave alone. Only `gamification.ts`'s patron/partner objects move to the lib.
