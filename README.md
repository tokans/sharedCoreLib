# sharedcorelib

App-agnostic, local-first infrastructure shared across a family of independent
Tauri + React apps (myFinance, myHealth, and future ones) **without the apps
depending on each other**. It is a **library**, not an app: no app DB, no pages,
no branding — only reusable mechanisms parameterized by an **injected config
object** (dependency injection, no module-level singletons). This mirrors the
[`@mydemo/core`](../myDemo) extraction precedent.

Consume it from an app via a local path dependency:

```jsonc
// app/package.json
"dependencies": {
  "sharedcorelib": "file:../sharedCoreLib"
}
```

The library compiles to `dist/` (JS + `.d.ts`). It ships as a **runtime-shared L2
asset**: the shared-runtime bundle is downloaded **once per client** into the
per-user suite dir and **reused by every installed app** (the first app to be
downloaded bootstraps it if absent; later apps — even installed directly from the
web — detect and reuse it). The shared runtime stays backward-compatible within a
**3-version deprecation window** (an API deprecated at core `vN` keeps working through
`vN+1`/`vN+2` and may be removed at `vN+3`), and the publisher keeps every installed
app pinned to the latest shared runtime, so one update benefits all apps — with a
multi-release runway for any removal. Each app additionally bundles only its **app-specific**
content (pages, domain, branding) — never the shared code. See
[`CONTRACT.md`](./CONTRACT.md) for the L1/L2 split and the install/reuse/refcount/
version contract.

## Build

```bash
npm install
npm run build      # tsc -> dist/
```

Apps that consume it via `file:` should build the library before building
themselves (myFinance wires this through a `prebuild` step).

## Features

Fifteen subsystems, each a subpath export. Every factory takes a **resolved config
object** and closes over its own state — there is no module-level singleton, so two
apps can hold independent instances in one process. See [`CONTRACT.md`](./CONTRACT.md)
for the per-subsystem app-config shape and what stays in-app.

**Shared vs app-specific.** Most subsystems are **suite-shared** — one client-side
runtime serves every installed app: env (1), crypto (2), vault (3), report (8),
ice (9), sync-kernel (10), ui (11), the suite update manager (12), entitlement
grants (13), the schema registry (14), and the shared DB runtime (15). Masters (4) hold
**both common and app-specific** tables. Tiers (5) provides the shared **standard top
tiers** (Patron/Partner) but each app's earned ladder, gates (6) and reminders (7) are
**app-specific**: the mechanism is shared, the data per app. Status: **all 21 subsystems
are implemented and unit-tested** (15 original + the v3 spine/recovery/breakglass/account/
pii/multiuser additions). The suite
updater (12) ships the verification **engine** (delegation-chain verify, anti-rollback,
freshness, verify-at-load) + types; each app injects the network/fs/lease adapters, the
hot-reload/stage handlers, and the **native-shell** confirmation UI (see `CONTRACT.md` §7).

| # | Subsystem | Import | What it provides | App injects |
|---|---|---|---|---|
| 1 | **Environment detection** | `sharedcorelib/env` | `isTauri`, `isWeb`, `isMobile`, `isDesktop` — distinguish the Tauri webview from a plain browser so Tauri-only paths can be gated and pages still render in preview | — (fully generic) |
| 2 | **Export crypto** | `sharedcorelib/crypto` | `encryptJson` / `decryptJson` — passphrase-sealed offline export packages. `PBKDF2(150k, SHA-256) → AES-256-GCM`, self-describing `salt(16)‖iv(12)‖ciphertext`. Web-Crypto only (no Tauri/Node dep) | the passphrase |
| 3 | **Encrypted vault** | `sharedcorelib/vault` | `createVault(config) → Vault` — Stronghold credential store, per-device document key (DEK), AES-256-GCM blob sealing, on-disk encrypted blob store; serialized op-chain so overlapping snapshot writes can't corrupt. Pure `sealWithKey`/`openWithKey` + `Credential` type | `clientName`, `snapshotFile`, optional `docKeyRecord`/`documentsSubdir`. ⚠️ Argon2 salt/params live in the app's Rust shell, **never** here |
| 4 | **Masters / OTA** | `sharedcorelib/masters` | Signed reference-data engine: `mergeMasterOptions` (4-layer de-dupe), `pickMode`/`DROPDOWN_MAX`, verify pipeline (`verifyAndDecryptManifest`, `verifyManifestSignature`, `sha256Hex`, `decryptTransport`, `meetsMinVersion`, `genericManifestSchema`), `createOtaUpdater(config)`, plus **common masters + namespacing** (below). Receive-only | release `baseUrl`, `pubkeyHex`, `transportKeyB64`, its own app-master registry + zod schemas, `getLastRevision`/`applyEntry` adapters, L2 `cacheDir`/`cacheNamespace` |
| 5 | **Engagement tiers** | `sharedcorelib/tiers` | `resolveTier`, `tierReached`, `nextEarnedTiers`, `TierDef` — pure N-tier ladder resolution (highest-first, grant tiers outrank). Plus the **standard top tiers** every app shares: `standardTopTiers` (**Patron**/**Partner**, grant), `hasPatronAccess`, `becomePatronVisible` (CTA after the 2nd earned tier), `PatronPartnerCtx` | the app's **earned** ladder + display fields; spread `standardTopTiers()` on the end. Patron/Partner status comes from `sharedcorelib/grant` |
| 6 | **Feature gating** | `sharedcorelib/gating` | `FeatureGate`, `isFeatureUnlocked`, `createGatingStore(config)`, `GatingState` — Zustand store that starts locked, `refresh()`es from app data, unlocks-all in a browser/dev preview, and (via `override`) **unlocks everything for a Patron/Partner** | flag shape, gate defs + copy, `computeFlags()`, `unlockedAll`, optional `override` (wire to `hasPatronAccess`). `FeatureGuard` UI stays in-app |
| 7 | **Reminders** | `sharedcorelib/reminders` | Pure day-precision scheduling (`daysBetween`, `addDaysISO`, `addYearsISO`, `bucketFor`, `shouldNotify`, `nextAnnual`, `fyReviewDueDate`, `byDueDate`, `dueLabel`, `isSnoozed`, `DUE_SOON_DAYS`, `ReminderLike`), OS notifications (`ensureNotificationPermission`, `sendNotification`), and `runReminderSweep(adapters)` (one notification per sweep) | derived-reminder generators + DB adapters (`syncDerived`, `listOpen`, `markFired`) + `today` |
| 8 | **Report → PDF** | `sharedcorelib/report` | `printHtmlAsPdf` (hidden-iframe webview print), `escapeHtml` — no PDF dependency, no backend | the report HTML templates |
| 9 | **ICE / emergency** | `sharedcorelib/ice` | `mentionsContact`, `telHref`, `mailtoHref`, `hasActionableContact`, `CONTACT_PHRASES` — deterministic keyword/regex contact extraction (no LLM) | ICE-card fields + disclaimer copy |
| 10 | **Sync kernel** | `sharedcorelib/sync` | `isNewer` (last-writer-wins: newer `updated_at`, `device_id` tie-break), `SyncDb` interface | table SPEC, change-set/`Bundle` shape, merge engine, Rust transport (all schema-bound). Envelope crypto = `sharedcorelib/crypto` |
| 11 | **UI foundation** | `sharedcorelib/ui` | `cn` (clsx + tailwind-merge), `ClassValue`, and the suite-standard **publisher attribution** `SupportedByTokans` ("Supported by Tokans.org") for the app's bottom status bar — bakes in no Tailwind classes | the status-bar `className` (+ a Tauri `onActivate` OS opener); heavier UI kit (shadcn primitives, `AppShell`, `FiniteSetInput`) deferred — see `CONTRACT.md` |
| 12 | **Suite update manager** | `sharedcorelib/suite` | Client-side, **background non-blocking** updater shared by every installed app: `createSuiteUpdater(config)` + `TrustAnchor`/`DelegatedKey`/`PublishedApp`/`SuiteSnapshot`/`SuiteTimestamp` types + pure verify helpers (`verifyDelegated`, `verifyTargetBytes`, `isFresh`, `passesAntiRollback`, `buildUpdatePlan`). A signed-feed check updates common masters, the **published-apps registry**, app versions and the **shared-runtime (self) version** — delegation-chain verify → freshness → anti-rollback → verify-at-load. Webview content **hot-reloads live**, native updates **apply on next launch**. Also the **app marketplace** (`createAppCatalog`) — the mobile "More" surface listing installed + uninstalled apps; click **opens** an installed app, **downloads** an available one, or **enrolls** for a Patron/Partner-gated app (e.g. `myWorkAssistant`). See *Suite update architecture* below | the baked trust anchor; `fetchFile`/`now`/lease adapters; installed-version lookups; the **native-owned** `confirmUpdate`; apply/stage handlers; for the marketplace, registry + local-state adapters + `openExternal`/`launchApp` + `entitlements` |
| 13 | **Entitlement grants** | `sharedcorelib/grant` | `verifyGrant`, `createGrantReceiver` — the **receive-only** Patron/Partner completion handoff: a signed-then-encrypted grant the app only ever *receives*, via a **dropped file** or an **anonymous backend token** (verify Ed25519 → decrypt AES-GCM → parse). Never uploads | grant signing keys (separate from masters), `parsePayload`, and the receive-only channels (`readDroppedFile` / `fetchByToken`) |
| 14 | **Schema registry** | `sharedcorelib/schema` | `SchemaDescriptor`/`FieldDescriptor`/`RelationshipDescriptor` — **semantic** data-schema model (purpose, confidentiality, DPDP `personalData`, editability, constraints, relationships), modeled on the hyperclaw schemata. `validateDescriptor` (+ DPDP rule), `compareSchema`/`checkAgainstRegistry`/`mergeIntoRegistry` — the **publish-time conflict/merge** engine for the shared suite DB (identical → no-op, additive → merge, else → reported conflict; flags cross-owner duplicates) | each table's descriptor (fields/relationships/constraints/purpose/confidentiality); the registry snapshot to check against |
| 15 | **Shared DB runtime** | `sharedcorelib/db` | The ONE shared suite database over an injected `SqlDb`: DDL gen (`createTableSql`/`addColumnSql`/`migrationFor`), the on-disk **schema registry** (`registerSchemas` — append-only migrate, conflict-block at runtime), and **confidentiality-governed** access (`createSharedDb` → `read`/`write`/`list` exposing only tables/fields at/below the caller's level; writes restricted to the owning app) | an injected `SqlDb` (Tauri SQL plugin), the caller's `appId` + granted `Confidentiality` |
| 16 | **Shared-entity spine** | `sharedcorelib/entities` | `createEntitiesStore` + `ENTITY_SCHEMAS` — the `person`/`event`/`document`/`asset` spine (all `owner:"common"`), `person` is identity-only with per-app facets, dormant `PersonRelationship` edges, **explicit-reference identity** (`pickOrCreatePerson`, never auto-merge), `suggestDuplicates` guided-merge, `assetsForOwner` aggregation. Contract: `contracts/entities.md` | an injected `SqlDb` + `appId` |
| 17 | **Account recovery** | `sharedcorelib/recovery` | `generateRecoveryKey`, `wrapMasterKey`/`unwrapMasterKey` (audited SCX1 seal), `createRecovery` (local + zero-knowledge escrow, re-key forward protection), GF(256) **Shamir** `splitSecret`/`combineShares` (M-of-N). RK never vendor-held | a `RecoveryBlobStore` (local) + optional `EscrowClient` (registered tier) |
| 18 | **Break-glass** | `sharedcorelib/breakglass` | Frozen **contributor interface**, `buildSnapshot` (tier redaction), `wrapSlice`/`openSlice` (zero-knowledge recipient slice + **license-free reader**), `isReleaseEligible` (dead-man's-switch), grant ledger + audit. Contract: `contracts/breakglass.md` | each app's `BreakGlassContributor`; an injected `SqlDb`; a `BreakGlassEscrow` |
| 19 | **Account client** | `sharedcorelib/account` | `createAccountClient` — the tokans.org client (registered/paid only): register/login, recovery + break-glass escrow, dead-man's-switch heartbeat (+"I'm here" cancel), promise-card redeem, offline ed25519 receipt verify. **Ciphertext-only** egress (`assertNoPlaintextSecrets`). Wire shapes: `contracts/account-wire.md` | a TLS-only `HttpTransport`; optional `serverPubkeyHex` |
| 20 | **PII egress guard** | `sharedcorelib/pii` | `scanPayload`/`redactText`/`deidentifyText` (deterministic: email/phone/PAN/Aadhaar/Luhn-card/IP, no LLM), pluggable `PiiEngine` (OpenMed sidecar stub), SSR-safe `PiiEgressDialog` (gated confirm-before-egress) | optional stronger engine (paid Python sidecar) |
| 21 | **Multi-user crypto** | `sharedcorelib/multiuser` | Shared key **multi-wrapped per user** (`multiWrap`/`addMember`/`removeMember` with rotation), per-user **private compartments** (`canAccessCompartment`/`syncTargets`/`rowsForRecipient`), `coUserRewrap` co-user recovery. Reuses the recovery seal. ⚠ rollout is a human staging decision | per-user keys; row `compartment` tags |

## Masters

The core **owns** a set of common reference masters, defined once in
[`src/masters/common.ts`](src/masters/common.ts) and reused by every app via
`getCommonBaked(id, parent)` — so apps don't ship duplicate copies. Master ids are
**scope-qualified** (`common:<id>` for core-owned, `<appId>:<id>` for app-owned) so a
shared store has no name/search conflicts.

| Master id | Scope | Source data | Shape | Notes |
|---|---|---|---|---|
| `country` | `common` | [`countries.json`](src/masters/data/countries.json) | `MasterOption[]` | core-owned, baked |
| `city` | `common` | [`cities.seed.json`](src/masters/data/cities.seed.json) | `Record<countryCode, string[]>` | **parent-scoped** — `getCommonBaked("city", countryCode)` |
| `currency` | `common` | [`currencies.json`](src/masters/data/currencies.json) | `MasterOption[]` | core-owned, baked |
| `relationship` | `common` | [`relationships.json`](src/masters/data/relationships.json) | `MasterOption[]` | core-owned, baked |

Helpers: `COMMON_SCOPE`, `COMMON_MASTER_IDS`, `isCommonMaster(id)`,
`qualifyMasterKey(scope, id)`, `parseMasterKey(key)`, `getCommonBaked(id, parent?)`,
`CommonMasterId`.

**Option model** — every master option is a `MasterOption` (`value`, `label`,
optional `icon`, `source: "baked" | "live" | "custom" | "remote"`). `mergeMasterOptions`
layers groups in priority order (remote ⊕ baked ⊕ live ⊕ custom), first occurrence of a
value wins. `pickMode(count)` returns `"dropdown"` below `DROPDOWN_MAX` (10) options,
`"autocomplete"` at/above.

App-specific masters (e.g. `myfinance:institution`) live in each app's own SQLite
under the app scope — the downloaded OTA bytes are shared, the materialised per-app
tables are not. See [`CONTRACT.md` §5.7](./CONTRACT.md).

### Published-apps registry (`common:app`)

A core-owned common master listing **every app the publisher has released**, refreshed
by the daily suite check (§ *Suite update architecture*). It is the catalogue behind an
in-app "more from this publisher" / suite launcher, and the source of truth for what can
be installed and sync-enabled on this client. Each row has two parts:

| Field | Origin | Purpose |
|---|---|---|
| `appId` | feed | stable id, e.g. `myfinance` |
| `name`, `tagline`, `description`, `icon` | feed | catalogue display |
| `marketingUrl` | feed | the app's marketing page |
| `downloadLinks` | feed | per-platform installers (win/mac/linux/ios/android) |
| `latestVersion` | feed | newest published app version (drives update prompts) |
| `latestCoreVersion` | feed | newest shared-runtime version this app expects |
| `installed` | **client-local** | is this app present on this client? |
| `installedVersion` | **client-local** | version currently installed here |
| `phoneSyncEnabled` | **client-local** | is this app opted into phone sync on this client? |

The catalogue half is signed + shared (downloaded once, reused); the **client-local**
state half lives in the shared suite manifest (never uploaded — receive-only). Lookups
are by the qualified key `common:app`.

### App marketplace / launcher — the mobile "More" surface

Every installed suite app exposes a **store-like marketplace** (placed under "More" on
mobile) that lists **all** the publisher's apps — both **installed** and **not yet
installed** — so the user can discover, install, and manage the suite from inside any app.
`createAppCatalog(config)` provides the data + actions (the app renders the UI):

| Method | Does |
|---|---|
| `list()` / `listInstalled()` / `listAvailable()` | published apps joined with this client's install/sync state; `listAvailable` is the "discover" tab (not-installed, excludes the current app) |
| `activate(appId)` | the **row click**: installed → **open the app**, not installed → **download it**, current app → no-op |
| `open(appId)` | launch an installed app (via the injected `launchApp` deep-link / OS launch) |
| `install(appId)` | download: opens the platform installer link / store page (the **OS** installs) |
| `openMarketing(appId)` | opens the app's marketing page |
| `markUninstalled(appId)` / `setPhoneSync(appId, on)` | record uninstall / toggle phone-sync in client-local state |

Each row (`AppCatalogEntry`) carries `isCurrentApp`, `updateAvailable`, the resolved
`downloadUrl`, and a **`primaryAction`** (`"open"` | `"download"` | `"current"`) so the UI
shows the right thing: **installed apps show an installed badge and launch on click;
not-installed apps download on click**. Install/launch are **OS-mediated** (open a link /
deep-link); the registry tracks client-local state. Pure helpers (`pickDownloadLink`,
`updateAvailableFor`, `primaryActionFor`, `toCatalogEntry`) are unit-tested.

## Suite update architecture

A single client-side service, shared by every installed app, that keeps reference
data **and versions** current from the publisher's signed web feed. The verification
**engine** (`sharedcorelib/suite`) is implemented and unit-tested; the app supplies the
IO adapters and the native confirmation UI. Behaviour was settled with these decisions:

- **Shared runtime, updated once.** The shared library's compiled JS is an L2
  shared-runtime bundle, backward-compatible within a **3-version deprecation window**
  (deprecate at `vN` → removable at `vN+3`), downloaded once per client and reused by
  all apps; the publisher keeps every app on the latest. App bundles contain only
  **app-specific** content. The first app downloaded checks whether the shared bundle
  exists and, if not, downloads it separately before continuing.
- **Native updates apply on next launch.** Webview/content updates (masters,
  registry, the shared-runtime JS, an app's own content pack) are swapped and
  **hot-reloaded live**; updates that touch the native Rust shell / sidecars download
  in the background and apply automatically on the **next app start** — no interruption.

**The daily check (background, non-blocking):**

1. **Trust anchor** — each app is built with the publisher feed's `baseUrl` +
   Ed25519 `pubkeyHex` + transport key baked in. The feed location is recorded as a
   master so it is auditable, and is **add-only on approval, immutable thereafter**:
   when the user approves downloading a **new** app, that app's feed/trust anchor is
   added to the client registry automatically (the download approval *is* the
   authorization). But the feed location for an **already-downloaded** app can never
   be changed — no feed payload can repoint an existing app's root of trust, so a
   compromised feed cannot hijack installed apps.
2. **One check per machine per day** — even with several apps open, a cross-process
   **lease + `lastCheckedAt`** in the shared suite manifest ensures exactly one app
   runs the check; the others read its result. Runs on startup and on a daily timer,
   always off the UI thread, fail-silent (offline / bad signature / downgrade → keep
   existing data).
3. **Fetch + verify** a signed publisher manifest carrying: the published-apps
   catalogue, each app's `latestVersion`, the `latestCoreVersion` (shared runtime),
   and the common-masters bundle revision. Verification reuses the masters pipeline
   (signature → revision/compat gate → per-file SHA-256 → AES-GCM transport decrypt).
4. **Diff** against installed app versions, the installed shared-runtime version, and
   the applied masters revision (anti-downgrade, tracked **per namespace**).
5. **Confirm, then download in the background** — when an update is available it is
   surfaced to the user; on confirmation the required files download in the
   background, are staged, and then applied per the hot-reload / next-launch rule.

**Install-once / reuse** folds into the existing L2 bootstrap (`ensure_shared_core`,
`CONTRACT.md` §5): the shared dir holds the shared-runtime bundle, the masters cache,
the published-apps registry + client-local state, and the updater lease. Adding/removing
an app is refcounted via `owners[]`; the shared dir is deleted only when the last app is
removed, so uninstalling one app never breaks another.

## Security

Because the shared runtime is downloaded and **hot-reloaded as executable code** across
every installed app, the updater is treated as a software-supply-chain channel, not a
data feed. The full model — trust boundaries, the offline-root **key hierarchy** (so
operational keys rotate while the baked anchor stays immutable), the **TUF-style** update
flow (anti-rollback + freshness + verify-at-load), crypto hygiene, sync hardening, and
accepted residual risk — is in **[`THREAT_MODEL.md`](./THREAT_MODEL.md)**.

These protocols are **mechanically enforced at each consuming app's build stage** by
[`publisher-ci`](./publisher-ci) — a **dev-only** toolkit (a `devDependency`, **never
bundled into the downloadable runtime**) that fails CI when an app drifts (weak KDF,
unpinned critical dep, non-baked trust anchor, missing anti-rollback metadata, plaintext
endpoint, premature API removal). An app wires it once:

```bash
npx sharedcorelib-publisher-ci init    # scaffold trust manifest + signing config + CI gate + release pipeline
npx sharedcorelib-publisher-ci check    # exit 1 on findings at/above the threshold
```

**Cross-account distribution.** `init` also scaffolds a release pipeline (the myFinance
precedent): source stays in the dev account, but builds, GitHub Releases, and a **gh-pages**
site publish to a separate **publisher account** (`tokans`) under a repo named for the
source, via a `PUBLISH_TOKEN` PAT. Feed/runtime signing stays **offline** (keys never enter
CI); the `release-pipeline` check enforces all of this.

## Repository layout

| Path | Ships in the downloadable runtime? | What |
|---|---|---|
| `src/` → `dist/` | **yes** (the L2 shared runtime) | the 12 subsystems |
| `publisher-ci/` | **no** (dev-only, separate package) | the security CI/CD toolkit consuming apps use as a `devDependency` |
| `THREAT_MODEL.md`, `CONTRACT.md` | no (docs) | the security + consumption contracts |
| `MIGRATION_PROMPT.md` | no (docs) | a ready-to-run prompt to migrate an existing app (myFinance) onto this core, deleting now-shared duplicates |

The lib build (`tsc` with `include: ["src"]` + `copy-data`) only emits `src/`, so
`publisher-ci/` is never part of the published runtime.

## Non-negotiable principles

1. **Standalone-first** — an app must run with no sibling installed: if the shared
   runtime is absent on first launch it bootstraps it; if the feed is unreachable it
   falls back to bundled/cached data. No app ever hard-depends on another app.
2. **Dependency injection, no singletons** — every export takes a resolved config.
3. **App owns its domain** — domain logic, pages, branding and disclaimers stay in each
   app. Its **data schema** is owned but **registered** in the shared schema registry
   (and may be a shared common table) — see principle 8.
4. **Per-app secrets stay per-app** — notably the vault's Argon2 salt/params,
   which are passed in as config and **must never change for an existing app**.
5. **Receive-only, never upload** — a backend *may serve* data to apps (masters
   bundles, update-availability, the **donation-completion** and **partner-status**
   grants); apps only ever *receive* and **never upload user data**. The only
   data-egress is user-initiated and lives *outside* the apps: the **donation**
   (anonymous, on tokans.org) and **Partner enrollment** (details collected on the
   portal — the app just receives "you're a Partner"). **myWorkAssistant** is the one
   explicit carve-out: a full-backend professional app that does not carry this promise.
   Also: no LLM in product logic; append-only migrations.
6. **Shared-runtime evolves under a 3-version deprecation window** — because one
   shared bundle serves every app, an API may only be removed after being marked
   deprecated for 3 core versions (`vN` deprecate → `vN+3` remove). Every release
   stays compatible with the last 3; breaking a still-supported API is forbidden.
7. **Trust anchor is add-on-approval, then immutable** — a new app's feed/signing
   anchor is added when the user approves its download; an installed app's anchor can
   never be repointed by feed data.
8. **One shared DB, no duplication, governed access** — installed apps share a single
   client-side database with per-app tables PLUS shared **common** tables (a single copy
   of data many apps use). Every table is described by a **semantic schema**
   (`sharedcorelib/schema`) with purpose, confidentiality, DPDP `personalData`/`purpose`,
   and constraints. On publish a schema is **checked + merged** against the registry —
   identical/additive merges, anything incompatible is a reported conflict that blocks
   publish, and the same data modeled twice is flagged. **Confidentiality governs
   cross-app reads**; this relaxes the old per-app-isolated-DB rule but **not** the
   per-app vault (still strictly isolated).
