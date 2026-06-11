# sharedcorelib — consumption contract

The canonical reference for how an app in the suite (myFinance, myHealth, future
ones) consumes the shared core **identically**, and the install/reuse/refcount/
version contract for the heavy shared runtime assets. Mirrors the `@mydemo/core`
precedent: standalone package, consumed via `file:../`, **dependency-injected
config — no module-level singletons**.

> Names are placeholders — rename `sharedcorelib` / `C:\workspace\sharedCoreLib` /
> the `SharedCoreLib` suite dir to taste; keep the `file:../` + DI shape.

---

## 0. Two layers of "core"

| Layer | What | Sharing |
|---|---|---|
| **L1 — app-specific bundle** | each app's OWN pages, domain, branding (NOT the shared code) | Bundled into the app's webview bundle at build time. Per app; keeps apps standalone. |
| **L2 — runtime-shared assets** | the **shared-runtime library bundle** (this package's compiled JS), the OTA masters cache, the published-apps registry + client-local state, the updater lease, and any native sidecars/models | **Installed once into a per-user shared suite dir and reused** by every installed app (first app downloaded bootstraps it if absent; later apps — even installed directly from the web — detect and reuse it). The shared runtime stays backward-compatible within a **3-version deprecation window** (deprecate at `vN`, removable at `vN+3`) and the publisher pins every app to the latest, so one update benefits all. This is the "first app installs, the rest reuse" win. See §5. |

> **Revised from the original precedent.** Earlier this package was bundled per app
> (L1, "not runtime-shared"). It is now a **runtime-shared L2 asset** so a single
> background update lifts every installed app; only app-specific content stays in L1.
> The suite update manager (§7) downloads and hot-reloads it.

---

## 1. How an app consumes the core (L1)

1. Add the dependency:
   ```jsonc
   // app/package.json
   "dependencies": { "sharedcorelib": "file:../sharedCoreLib" }
   ```
2. Build the library before the app (its subpath `exports` point at `dist/`).
   myFinance does this with a `prebuild` script:
   ```jsonc
   "scripts": { "prebuild": "npm --prefix ../sharedCoreLib run build" }
   ```
   (`npm install` in the lib once, so its own devDeps exist.)
3. The app's `tsconfig.json` must use `"moduleResolution": "Bundler"` (or
   `NodeNext`) so subpath `exports` resolve. `skipLibCheck: true` keeps the lib's
   emitted `.d.ts` from being re-typechecked under the app's stricter flags.
4. Import from subpaths and **inject config** — never rely on a global.

The package is ESM-only (`"type": "module"`); each subpath exposes `types` +
`import` conditions. Tauri plugins, `react`, `zod`, `zustand`, `@noble/*`,
`clsx`, `tailwind-merge` (and, once the primitive UI kit lands per §4.2,
`tailwindcss` + `tailwindcss-animate`) are **peerDependencies** (the app provides
the single bundled copy); the lib also lists them as devDeps so it type-checks in isolation.

---

## 2. Subpath exports & public API

| Import | Exports | App supplies |
|---|---|---|
| `sharedcorelib/env` | `isTauri`, `isWeb`, `isMobile`, `isDesktop` | — (fully generic) |
| `sharedcorelib/crypto` | `encryptJson`, `decryptJson` (PBKDF2→AES-GCM, `salt‖iv‖ct`) | the passphrase |
| `sharedcorelib/vault` | `createVault(config)` → `Vault`; pure `sealWithKey`/`openWithKey`; `Credential` | `clientName`, `snapshotFile`, optional `docKeyRecord`/`documentsSubdir`. **Argon2 salt/params are NOT here — they live in the app's `src-tauri/src/lib.rs` and must never change** (see §3). |
| `sharedcorelib/masters` | merge: `mergeMasterOptions`, `pickMode`, `DROPDOWN_MAX`, `MasterOption`; verify: `verifyManifestSignature`, `sha256Hex`, `decryptTransport`, `meetsMinVersion`, `verifyAndDecryptManifest`, `genericManifestSchema`; OTA: `createOtaUpdater(config)`; **common masters + namespacing**: `getCommonBaked`, `COMMON_MASTER_IDS`, `isCommonMaster`, `COMMON_SCOPE`, `qualifyMasterKey`, `parseMasterKey` (see §5.7) | release `baseUrl`, signing `pubkeyHex`, `transportKeyB64`, its OWN **app-specific** master registry + zod schemas (reusing the common sets), `getLastRevision`/`applyEntry` adapters, and (for L2) `cacheDir` + `cacheNamespace` |
| `sharedcorelib/tiers` | `resolveTier`, `tierReached`, `nextEarnedTiers`, `TierDef`; **standard top tiers**: `standardTopTiers`, `hasPatronAccess`, `becomePatronVisible`, `PatronPartnerCtx`, `PATRON_TIER_KEY`/`PARTNER_TIER_KEY` | the app's **earned** ladder (each `{key,label,criteria,reached,grant?}`) + display fields; spread `standardTopTiers()` on the end (Patron/Partner are shared). Patron/Partner status comes from `/grant` |
| `sharedcorelib/grant` | `verifyGrant`, `createGrantReceiver`, `GrantEnvelope`/`GrantKeys`/`GrantReceiver` | grant signing keys (**separate** from masters keys), `parsePayload`, and the receive-only channels `readDroppedFile` / `fetchByToken` (file-drop / anonymous backend token). Receive-only — never uploads |
| `sharedcorelib/schema` | `SchemaDescriptor`/`FieldDescriptor`/`RelationshipDescriptor` + `validateDescriptor`, `compareSchema`, `checkAgainstRegistry`, `mergeIntoRegistry`, `qualifiedName`, `Confidentiality`/`CONFIDENTIALITY_ORDER` | each table's semantic descriptor (fields/relationships/constraints/purpose/confidentiality/`personalData`); the registry snapshot to check against (see §8) |
| `sharedcorelib/db` | DDL: `createTableSql`/`addColumnSql`/`migrationFor`/`sqliteType`/`tableName`; registry: `ensureRegistry`/`loadRegistry`/`registerSchemas` (append-only migrate + conflict-block); governance: `createSharedDb({appId,grantedLevel,registry})` → `read`/`write`/`list`, `visibleColumns`/`schemaVisibleAt`/`canAppWrite`; `SqlDb` | an injected `SqlDb` (the Tauri SQL plugin), the calling `appId` + granted `Confidentiality`. Runs the ONE shared suite DB (see §8) |
| `sharedcorelib/gating` | `FeatureGate`, `isFeatureUnlocked`, `createGatingStore(config)`, `GatingState`; **person-linked**: `revealKey(user,app,gate?)`, `PRIMARY_USER_KEY`; **nudge**: `pickNudge`/`Nudge`/`NudgeContext`; **`FeatureGuard`** (SSR-safe, promoted into core) | flag shape, gate defs + copy, `computeFlags()` (queries app DB), `unlockedAll`, optional `override` (wire to `hasPatronAccess`). `FeatureGuard` takes `renderLocked`/`renderLoading` for app-specific UI. |
| `sharedcorelib/backup` | Whole-store **Excel backup/restore** every app exposes from Settings: `createExcelBackup(config)` → `plan()`/`exportWorkbook()`/`importWorkbook()` — ONE `.xlsx`, one sheet per table + `_meta`/`_tables`/`_schemas` sheets; `suiteSourceForApp(db, registry, appId)` selects the app's owned + `common` suite tables. **Secrets never export in the clear:** fields at/above the `hashAtOrAbove` confidentiality floor (default `Secret`), or matching the secret-name pattern in descriptorless tables, become one-way `sha256:<hex>` fingerprints and are **skipped on import** (a fingerprint can never overwrite a real secret). Import is `merge` (upsert) or `replace`; foreign-app files refused unless `force`; absent descriptor-backed tables are recreated from the embedded `_schemas`. `BACKUP_FORMAT`/`BACKUP_FORMAT_VERSION`/`HASHED_VALUE_RE`, `XlsxModule` | its `SqlDb` handles (own app DB + the suite slice via `suiteSourceForApp`), its `appId`, and **its own SheetJS module** (`xlsx` is injected via `XlsxModule` — NOT a core dep; the app already bundles it or adds it). Settings UI: drop in **`BackupPanel`** from `sharedcorelib/ui` (pass a Tauri `save` handler; browser download is the preview fallback) |
| `sharedcorelib/reminders` | pure scheduling (`daysBetween`, `addDaysISO`, `addYearsISO`, `bucketFor`, `shouldNotify`, `nextAnnual`, `fyReviewDueDate`, `byDueDate`, `dueLabel`, `isSnoozed`, `DUE_SOON_DAYS`, `ReminderLike`); notify (`ensureNotificationPermission`, `sendNotification`); `runReminderSweep(adapters)` | the derived-reminder generators + DB adapters (`syncDerived`, `listOpen`, `markFired`) + `today` |
| `sharedcorelib/report` | `printHtmlAsPdf`, `escapeHtml` | the report HTML templates |
| `sharedcorelib/ice` | `mentionsContact`, `telHref`, `mailtoHref`, `hasActionableContact`, `CONTACT_PHRASES` | ICE-card fields + disclaimer copy |
| `sharedcorelib/sync` | `isNewer` (LWW rule), `SyncDb`; **per-app-scoped merge engine** (promoted from apps): `createMergeEngine`/`syncableTables`/`buildBundle`/`applyBundle`/`SyncTransport` — syncs only owned + `common` tables (receive-side scoped). Apps delete their local `merge.ts` | the schema `registry` + `appId` + `localDeviceId`; the Rust LAN transport as the injected `SyncTransport`. Envelope crypto = `sharedcorelib/crypto`. |
| `sharedcorelib/ui` | **Purge-safe:** `cn`, `ClassValue`; **publisher attribution** (`SupportedByTokans`, `tokansAttribution`, `SUPPORTED_BY_LABEL`, `TOKANS_URL`, `TOKANS_LOGO_DATA_URI`); **`AppHarness`** unstyled responsive primitive (slots + `pickOrientation`/`useViewportWidth`/`themeStyle`/`DEFAULT_THEME`/`SuiteThemeToken`/`chromeActions`). **Styled kit (needs §4.2 preset + `theme.css` + content glob):** **`SuiteShell`** (`SuiteNavItem`/`SuiteAction`/`SuiteAccount` — sidebar + mobile top bar + 3-button bar + adaptive central sheet + More drawer + `profile` slot + tier-gated `account`) and **`Sheet`**/`SheetContent`/`SheetClose` drawer. Also: **`sharedcorelib/tailwind-preset`** (Tailwind preset) + **`sharedcorelib/ui/theme.css`** (default token values). | for `SuiteShell`: `brand`, `nav` (precomputed `state`), `centralActions`, `actions`, `profile` slot, optional `account` (tier ≥ 2), `onExternal`. Must render inside the app's `react-router-dom` Router. **primitive** kit (`FiniteSetInput`, shadcn primitives) still deferred — see §4 |
| `sharedcorelib/entities` | `createEntitiesStore`, `ENTITY_SCHEMAS`, `personKeyFor`; the `person`/`event`/`document`/`asset` spine (all `owner:"common"`) — identity-only `person` + per-app facets, dormant `PersonRelationship` edges, **explicit-reference identity** (`pickOrCreatePerson`, no auto-merge), `suggestDuplicates`, `assetsForOwner`. **Contract:** `contracts/entities.md` | an injected `SqlDb` + `appId`. Read/write the spine via this — never re-model it (invariant 6) |
| `sharedcorelib/recovery` | `generateRecoveryKey`, `wrapMasterKey`/`unwrapMasterKey`, `createRecovery` (local + zero-knowledge escrow + re-key), Shamir `splitSecret`/`combineShares`/`splitRecoveryKey`; `RecoveryBlobStore`/`EscrowClient`/`WrappedKey` | a local `RecoveryBlobStore`; optional registered-tier `EscrowClient`. RK is user-held, never vendor-held |
| `sharedcorelib/breakglass` | `BreakGlassContributor` (frozen contributor interface), `buildSnapshot` (tier redaction), `generateRecipientPassphrase`, `wrapSlice`/`openSlice` (zero-knowledge slice + license-free reader), `isReleaseEligible`, `BREAKGLASS_SCHEMAS`/`createBreakGlassLedger`, `BreakGlassEscrow`. **Contract:** `contracts/breakglass.md` | each app's `BreakGlassContributor` (does its own redaction); an injected `SqlDb`; a `BreakGlassEscrow` (release gated by `account` 2FA) |
| `sharedcorelib/account` | `createAccountClient` → register/login, recovery + break-glass escrow, heartbeat (+cancel), promise-card redeem, `verifyReceipt` (offline ed25519); `assertNoPlaintextSecrets`/`FORBIDDEN_EGRESS_KEYS`; frozen wire shapes. **Contract:** `contracts/account-wire.md`. Registered/paid only — never a free-tier path | a TLS-only `HttpTransport`; optional `serverPubkeyHex`. Ships only ciphertext + minimal metadata |
| `sharedcorelib/pii` | `scanPayload`/`scanText`/`redactText`/`deidentifyText`/`redactPayload` (deterministic, no LLM), `PiiEngine`/`regexEngine`/`openMedEngine`, SSR-safe `PiiEgressDialog`/`summarizeMatches` | optional stronger engine (paid OpenMed Python sidecar). Use on every cloud egress (invariant 7) |
| `sharedcorelib/multiuser` 🟡 *staged* | `generateSharedKey`, `multiWrap`/`addMember`/`removeMember` (rotate-on-remove), `unwrapShared`, `coUserRewrap`; compartments: `privateCompartment`/`compartmentOf`/`canAccessCompartment`/`syncTargets`/`rowsForRecipient` | per-user keys; row `compartment` tags. Reuses the recovery seal. **Rollout is a human staging decision** |
| `sharedcorelib/suite` 🟡 *engine implemented* | `createSuiteUpdater(config)` → background daily check (masters + registry + app/self version), verify-at-load + anti-rollback + freshness + native-owned confirm → hot-reload/next-launch; `createAppCatalog(config)` → the **app marketplace** (mobile "More"): list installed + uninstalled apps, install/open-marketing/uninstall/phone-sync; `TrustAnchor`/`DelegatedKey`/`PublishedApp`/`AppLocalState` types + pure helpers (see §7) | baked trust anchor (feed `baseUrl` + root + delegated keys + transport key), `fetchFile`/`now`/lease adapters, installed-version lookups, the native `confirmUpdate(...)`, apply/stage handlers, and for the marketplace the registry + per-app-private local-state adapters + `openExternal` |

Every factory takes a **resolved config object**; there is no module-level state.
`createVault`/`createOtaUpdater`/`createGatingStore` close over their state, so the
returned methods are safe to destructure.

---

## 3. ⚠️ Per-app secret: the vault salt

The Stronghold snapshot key is derived with **Argon2id from a per-app constant
salt + params** in each app's **`src-tauri/src/lib.rs`** (`tauri_plugin_stronghold::Builder`).
It is **NOT** in this library and **must never change for an existing app** —
changing it makes every existing user's vault snapshot undecryptable (bricked).
The TS `createVault` only needs `clientName` + `snapshotFile`; the key-derivation
secret stays in the app's Rust shell. Each app uses its own distinct salt; vaults
are never shared between apps.

---

## 4. What is intentionally left in-app (and why)

- **Rust transport / `sync.rs` byte-pipe** — cross-language packaging is the
  prompt's explicit stretch goal. Each app keeps a thin `src-tauri` that wires the
  plugins + its own sync transport; the TS sync KERNEL (`isNewer`, `SyncDb`) +
  envelope crypto (`/crypto`) are shared.
- **Sync merge engine** — ✅ **promoted into core** (Phase 6). `sharedcorelib/sync` now
  ships `createMergeEngine`/`syncableTables`/`buildBundle`/`applyBundle`, a generic LWW engine
  that walks the schema registry and is **scoped per app** by table ownership (owned + `common`
  only). Apps **delete their local `src/sync/merge.ts`** and inject the Rust LAN byte-pipe as the
  `SyncTransport`. What remains in-app: only the native transport + any app-specific blob/credential
  re-seal hooks at the call site.
- **Launch telemetry** — recording launches / counting distinct days is DB-bound
  (app SQLite, an app migration). The shared part is the **tier ladder resolution**
  (`/tiers`); the telemetry that feeds the tier context stays per-app.
- **`FeatureGuard` gate defs / locked-state UI** — ✅ **`FeatureGuard` promoted into core**
  (Phase 6, SSR-safe, person-linked). The gate framework + store factory + `FeatureGuard` are now
  shared (`/gating`); the app still supplies its gate definitions + copy and the `renderLocked`
  /`renderLoading` UI (routing + unlock-in-place dialogs stay app-specific, injected as render props).
- **App shell / responsive layout** — ✅ **promoted into core as `AppHarness`** (`/ui`, Phase 6).
  The suite's responsive shell (slots + chrome + theming + horizontal↔vertical transform) that apps
  migrate their bespoke `AppShell` onto. See **§4.1**.
- **Styled shell + drawer** — ✅ **promoted into core** (`/ui`): the opinionated **`SuiteShell`**
  (sidebar + mobile top bar + three-button bottom bar + adaptive central sheet + More drawer +
  injected `profile` slot + tier-gated `account` button) and the **`Sheet`** drawer primitive it
  builds on. Unlike `AppHarness` (the unstyled layout primitive) these **bake Tailwind utilities**,
  so they are the first consumers of the §4.2 theming + content-glob policy. See **§4.1**.
- **UI primitive kit (shadcn primitives, `FiniteSetInput`)** — still in-app. Extracted so far:
  `cn`, the publisher attribution, `AppHarness`, `FeatureGuard`, and now `SuiteShell` + `Sheet`.
  Moving the remaining **primitives** (Button/Input/Dialog/…) and `FiniteSetInput` is the next UI
  step, governed by the **§4.2 theming + content-glob policy**: a consuming app uses the shared
  Tailwind **preset** + base **theme.css** and adds `../sharedCoreLib/src/ui/**` to its Tailwind
  `content` globs (else the utility classes are purged); `FiniteSetInput` additionally needs the
  app's master-data hook injected.

### 4.1 Migrating an app's `AppShell` → the shared shell

Two layers are available; **prefer `SuiteShell`** unless you need a fully bespoke layout.

#### 4.1.a `SuiteShell` — the opinionated, styled default (recommended)

`SuiteShell` (`sharedcorelib/ui`) is the suite's shared, **styled** shell — one consistent look for
every app across desktop and mobile. It owns the chrome; the app supplies **data + slots**:

- **`brand`** — icon + name lockup (sidebar header + mobile top bar).
- **`nav: SuiteNavItem[]`** — the full nav. Shown in full on the desktop sidebar; the non-home items
  fill the mobile **More** drawer. Mark one item `home` (the single mobile bottom-bar tab; its label
  is app-defined, e.g. "Today"). Each item carries a **precomputed `state`** (`"open" | "nudge"`) so
  the shell never imports app gating — compute it from your gating store and omit hidden items.
- **`centralActions: SuiteAction[]`** — the mobile center button is **adaptive**: 0 actions → no
  center button; 1 → a plain button that runs it; 2+ → a raised FAB that opens a bottom sheet.
- **`actions: SuiteAction[]`** — standard secondary actions (settings / donate / marketplace …),
  rendered in both the More drawer and the desktop sidebar footer. `moreExtra` / `moreHeader` /
  `sidebarTop` inject app-specific content (e.g. a tier badge).
- **`profile`** — the injected top-right slot (app-owned; e.g. myHealth's family-profile button +
  drawer). Keeps the shell free of login/multi-user semantics — **free apps stay login-less**.
- **`account?: { tier, … }`** — the OPTIONAL built-in account button, rendered **only at tier ≥ 2**.
- **`onExternal`** — Tauri OS opener for the auto-rendered "Supported by Tokans" attribution.

Routing uses `react-router-dom` (the suite standard — `NavLink`/`useLocation`), so `SuiteShell` must
render inside the app's `Router`. It is **styled with Tailwind utilities**, so the app must adopt the
**§4.2** theming policy: the shared preset, `theme.css`, and the `../sharedCoreLib/src/ui/**` content
glob. The reference adopter is **myHealth** (`src/components/layout/AppShell.tsx`).

#### 4.1.b `AppHarness` — the unstyled layout primitive

`AppHarness` (`sharedcorelib/ui`) is the lower-level, **purge-safe** responsive shell (no baked
utilities) for apps that need a bespoke look. To migrate:

1. **Feed width** — `const width = useViewportWidth();` (SSR-safe; returns 1024 before mount).
2. **Inject slots** — `nav` / `main` / `side` / `footer`. Each slot may be a node **or** a render-fn
   `(ctx) => node` receiving `{ orientation, width }`, so one harness renders a **desktop sidebar**
   and a **mobile bottom-bar**: `nav: (ctx) => ctx.orientation === "horizontal" ? <Sidebar/> : <BottomBar/>`.
   `verticalNavPosition` ("top"|"bottom", default "bottom") places the nav in the mobile column.
   Pass the router `<Outlet/>` as `main`.
3. **Wire chrome** — `chrome={{ tier, onPatron, onSettings, onMarketplace, onExternal, labels }}`.
   Patron shows only from `tier ≥ 2`. `onMarketplace` opens the app's marketplace page (built on
   `sharedcorelib/suite` `createAppCatalog`); the harness only triggers it. `SupportedByTokans` is
   rendered automatically in the footer (pass `onExternal` for the Tauri OS opener).
4. **Theme** — `theme={{ ...DEFAULT_THEME, "color-accent": "#…" }}`; tokens land as `--<token>` CSS
   custom properties (see `SuiteThemeToken` for the shared vocabulary). The harness bakes **no**
   utility classes — style via the app's own `className`s + these tokens (no Tailwind `content` change).
5. **SSR/web** — the harness never touches `window` at import or render, so the paid apps' web target
   can `renderToString` it (proven in `ui/harness.test.ts`).

The contract is tight on purpose: **four fixed slots + one config object**. App-specific nav items,
bottom-sheets, dialogs, and the locked-feature UI live in the slot/render-prop content, not the harness.

### 4.2 Theming model + Tailwind `content`-glob policy (decided 2026-06-10)

This is the policy that unblocks extracting the **primitive UI kit** (shadcn primitives + `FiniteSetInput`)
into `sharedcorelib/ui`. Goal: **mostly-common theming kept in the lib as the default, each app able to
override with styles kept in its own repo.** Three cooperating parts:

**Token vocabulary (the shared contract).** Theming is CSS custom properties in the shadcn convention —
HSL triples consumed via `hsl(var(--token))`: `--background`, `--foreground`, `--card(-foreground)`,
`--primary(-foreground)`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`,
`--ring`, `--radius`. These names are **canonical for the whole suite**. `AppHarness`'s older
`SuiteThemeToken`/`DEFAULT_THEME` set (`--color-card`, `--color-bg`, …) is **aligned to these names** when
the primitives land — the harness and the primitives must read the same variables.

**Layer 1 — shared defaults, owned by sharedCoreLib (the "default theme").**
- A **Tailwind preset** the lib exports (`sharedcorelib` package, built to e.g. `dist/tailwind/preset.cjs`)
  defining `darkMode: ["class"]`, the `theme.extend.colors` token→`hsl(var(--token))` mapping,
  `borderRadius` derived from `--radius`, and `plugins: [require("tailwindcss-animate")]`. This is what
  makes `bg-card` / `rounded-md` mean the same thing in every app.
- A **shared base stylesheet** (`sharedcorelib/ui/theme.css`) with `@layer base { :root { …suite default
  palette… } .dark { … } }` — the canonical default token values.

**Layer 2 — per-app override, owned by the app repo (the "branding").**
- App `tailwind.config`: `presets: [require("sharedcorelib/.../preset.cjs")]`, plus any **app-only**
  `theme.extend` for brand tokens the suite doesn't define.
- App `index.css`: pull in the shared `theme.css`, then **re-declare only the `:root`/`.dark` variables it
  wants different**. CSS cascade → the app's later declaration wins, so all branding lives in one place in
  the app and nothing is forked from the lib.

**Content-glob policy (orthogonal — controls *which* utilities compile, not what they resolve to).**
Tailwind v3 is a purge compiler: it only emits CSS for class strings it finds in files listed in `content`.
Because the shared primitives' class strings live in the lib, **every consuming app MUST add the lib's UI
source to its `content` globs**:

```js
// app tailwind.config.cjs
content: ["./index.html", "./src/**/*.{ts,tsx}", "../sharedCoreLib/src/ui/**/*.{ts,tsx}"]
```

Scan the lib **`src`, not `dist`** — `npm run dev` skips the core `prebuild`, so `dist` can be stale or
absent in browser-preview, whereas `src` is always present and the class strings are identical after `tsc`.
Forgetting this glob renders shared primitives **unstyled at runtime** (it still type-checks), so it is a
required setup step for any app adopting the primitive kit, and `publisher-ci` / the app template should
assert its presence.

**Dependencies.** `tailwindcss` + `tailwindcss-animate` are **peerDependencies** of the lib (the app
provides the single install; the lib only references the plugin from its preset) — consistent with the
heavy-deps-are-peerDeps invariant. `clsx`/`tailwind-merge` are already peers (for `cn`).

**Adoption order.** (1) lib publishes the preset + `theme.css` + token alignment; (2) an app adds the
content glob, switches its `tailwind.config` to the preset, and imports `theme.css`, keeping only its
override block; (3) primitives move into `sharedcorelib/ui` and the app deletes its local copies. Until an
app completes step 2 it keeps its current in-app config unchanged — the policy is additive, not a flag day.

---

## 5. Install / reuse / refcount / version contract (L2)

Implemented app-side in **`src-tauri/src/core_bootstrap.rs`** (portable across all
installers because it runs in `lib.rs` setup). myFinance is wired as the **first**
app that lays the core down.

### 5.1 Shared suite dir (per-user, no admin)

```
Windows : %LOCALAPPDATA%\SharedCoreLib\core\
macOS   : ~/Library/Application Support/SharedCoreLib/core\
Linux   : ~/.local/share/SharedCoreLib/core\
   ├─ manifest.json     # { "core_version": N, "owners": ["myFinance", ...] }
   ├─ masters/          # shared OTA reference-data cache (downloaded once, reused)
   ├─ bin/              # shared native sidecars (if any)
   └─ models/           # shared ML models (if any)
```
Resolved via Tauri's `local_data_dir()`, which maps to exactly those three roots.

### 5.2 Startup bootstrap (`ensure_shared_core`)

1. **Lay-down-or-reuse**: if the shared dir is absent **or**
   `manifest.core_version < CORE_VERSION` (this app's bundled L2 version) → create
   / upgrade the L2 layout and bump the version; else **reuse, install nothing**.
2. **Refcount**: add this app's `APP_ID` to `manifest.owners[]` (idempotent).
3. **Standalone fallback**: if the shared dir is missing/unwritable, fall back to
   the app's own `app_data_dir()/masters` — an app installed alone always works.
4. Returns the **masters cache dir** to inject into the OTA updater.

### 5.3 Uninstall (`deregister_shared_core`)

Remove this app's id from `owners[]`; delete the shared dir **only when
`owners[]` is empty**. Wire into the installer's uninstall step (platform-specific).
So removing one app never breaks another.

### 5.4 Masters OTA cache injection (the cleanest win)

`createOtaUpdater({ ... cacheDir })` accepts the shared masters path. The webview
gets it from the `shared_core_masters_dir` Tauri command (which calls
`ensure_shared_core`). The **first** suite app to pull downloads the signed bundle
into `…/core/masters`; the **second** reuses the cache — no second download. Each
app still applies only the master *types it registers* into its **own** SQLite
`master_options`/`partners` (the downloaded bytes are shared; the materialised
per-app tables are not). *Status:* the bootstrap + path injection + config knob are
in place; materialising the downloaded bundle to `cacheDir` (vs re-fetch) is the
remaining incremental step in `createOtaUpdater`.

### 5.5 Versioning

Backward-compatible **within a major**: apps require `coreMajor == N &&
coreMinor >= m`. A newer app **upgrades the shared core in place** (bumps
`core_version`); older apps keep working. A breaking change uses a **versioned
subdir** (`core/v2/`) so majors coexist and each app picks its own.

### 5.6 Never shared (security & independence)

**Vaults** (per-app Argon2 salt) and app **secrets/settings** stay **strictly per-app and
isolated**. The application **database is now shared** across installed apps (one suite DB
with per-app + common tables) — governed by the schema registry's confidentiality, see
**§8**. (This revises the original "app SQLite DBs stay per-app"; the vault does NOT.)

---

## 5.7 Common masters & conflict-free shared store

When the L2 layer is shared across apps, master ids are **scope-qualified** so a
shared store (the OTA cache, or a common masters DB) has **no name or search
conflicts**:

- **`common:<id>`** — reference data **owned by the core and reused by every app**,
  defined once in `sharedcorelib/masters/common.ts` (currently `country`, `city`,
  `currency`, `relationship`). Apps call `getCommonBaked(id, parent)` for the baked
  set instead of shipping their own copy. (myFinance now sources these from the
  core; its duplicate `cities.seed.json`/`relationships.json` were deleted.)
- **`<appId>:<id>`** — an app's own masters (e.g. `myfinance:institution`). Two
  apps can both define `institution` with no clash, and no app can shadow a
  `common:` master.

Helpers: `COMMON_SCOPE`, `qualifyMasterKey(scope, id)`, `parseMasterKey(key)`,
`isCommonMaster(id)`, `COMMON_MASTER_IDS`.

**Rules for any shared store** (so there are never name/search conflicts):

1. Key every row/file/bundle by the **fully-qualified** `scope:id`, never a bare
   id. Lookups/searches always filter by the qualified key.
2. In the OTA cache, each app writes under `createOtaUpdater({ cacheNamespace })`
   (default `COMMON_SCOPE`); the **common** masters bundle uses `COMMON_SCOPE` so
   it is downloaded **once** and reused, while each app's own bundle lives under
   its own namespace — no filename collisions.
3. A common masters **DB/store** in the shared dir holds `common:*` rows only,
   read by all apps; **app-specific masters stay in each app's own SQLite** under
   the app scope. The shared bytes are common; the materialised per-app tables are
   not (and carry the app scope), so an app's `institution` never overwrites
   another's.
4. The anti-downgrade revision is tracked **per namespace**, so a common-bundle
   update and an app-bundle update can't roll each other back.

This keeps "common masters defined once, reused everywhere" and "no name/search
conflicts in the shared db" true simultaneously.

## 6. Adoption checklist for a new app

1. `"sharedcorelib": "file:../sharedCoreLib"` + a `prebuild` that builds the lib.
2. Write one app-config: app name/db name, vault `clientName`/`snapshotFile` (+ the
   per-app Argon2 salt in `lib.rs`), OTA `baseUrl`+keys+registry+schemas, tier
   ladder, gate defs + `computeFlags`, reminder generators + adapters, report
   templates, ICE fields, sync SPEC + transport.
3. Call the core factories with that config; implement app-specific domain, pages,
   migrations, import.
4. Copy `core_bootstrap.rs` (change `APP_ID`), call `ensure_shared_core` in setup,
   register `shared_core_masters_dir`, and (on first download) bootstrap the
   shared-runtime bundle if absent (§7).
5. Bake the publisher feed trust anchor (`baseUrl` + `pubkeyHex` + transport key),
   wire `createSuiteUpdater` to run the daily check, and provide the
   `confirmUpdate` callback (§7). Mount the **app marketplace** (`createAppCatalog`) in
   the app's "More" surface so users can discover/install other suite apps (§7.6).
   Render the **publisher attribution** (`SupportedByTokans` from `sharedcorelib/ui`) in
   the app's **bottom status bar** — pass the app's own `className`, and in Tauri an
   `onActivate` wired to the OS opener so `tokans.org` launches in the user's browser,
   not the webview. This line is suite-standard; every app shows it identically.
6. Add `sharedcorelib-publisher-ci` as a `devDependency`, run `… init` to scaffold the
   trust manifest + signing config + CI gate + release pipeline, fill in real keys, and
   make `… check` a required CI step (it enforces the THREAT_MODEL.md controls).
7. Add `"@mydemo/core": "file:../myDemo"` as a `devDependency` and author a demo
   scenario per feature (`demo/scenarios/*`). Use it for **live testing + issue-fix**:
   record → open the GIF → fix what the demo surfaces → re-record (myFinance is the
   reference consumer). See the `create-suite-app` skill, Stage 9.
8. `npm run build` + `npm run test` + `npx sharedcorelib-publisher-ci check` green, and
   each feature's demo recorded → the app builds & runs standalone and is protocol-aligned.

---

## 7. Suite update manager (L2 service)

> Status: the verification **engine** (`createSuiteUpdater` + `TrustAnchor`/delegation
> types + `verifyDelegated`/`verifyTargetBytes`/`isFresh`/`passesAntiRollback`/
> `buildUpdatePlan`) is implemented and unit-tested. The app injects the network/fs/lease
> adapters, the hot-reload/stage handlers, and the native-shell `confirmUpdate` UI.


> **Security model:** the trust boundaries, key hierarchy, TUF-style update flow, and
> residual risks for everything in this section are specified in
> [`THREAT_MODEL.md`](./THREAT_MODEL.md), and enforced at each app's build stage by the
> [`publisher-ci`](./publisher-ci) dev toolkit (§9 of the threat model maps each control
> to its enforcer).

A single client-side, **background non-blocking** service — shared by every installed
app — that keeps reference data **and versions** current from the publisher's signed
web feed. Design settled with the publisher's two decisions:

- **Shared runtime, updated once** — the shared library JS is an L2 shared-runtime
  bundle, backward-compatible within a **3-version deprecation window** (deprecate at
  `vN` → removable at `vN+3`; every release stays compatible with the last 3),
  downloaded once and reused by all apps; the publisher pins every app to the latest.
  App bundles hold only app-specific content. The first app downloaded checks for the
  shared bundle and, if absent, downloads it separately before continuing.
- **Native updates apply on next launch** — webview/content updates (masters,
  registry, shared-runtime JS, an app's own content pack) are **hot-reloaded live**;
  native Rust shell / sidecar updates download in the background and apply on the
  **next app start**.

### 7.1 Trust anchor

Each app is built with the feed `baseUrl` + Ed25519 `pubkeyHex` + transport key baked
in. The feed location is recorded as a master so it is auditable, and is **add-only on
approval, immutable thereafter**: approving a **new** app's download automatically adds
that app's feed/trust anchor to the client registry (the approval *is* the
authorization), but an **already-downloaded** app's anchor can never be repointed by
any feed payload — so a compromised feed cannot hijack installed apps. Verification
reuses the `/masters` pipeline: signature → revision/compat gate → per-file SHA-256 →
AES-GCM transport decrypt.

### 7.2 The daily check

1. **One check per machine per day** — a cross-process **lease + `lastCheckedAt`** in
   the shared suite `manifest.json` ensures exactly one app runs the check even with
   several open; others read the result. Runs on startup + a daily timer, off the UI
   thread, fail-silent.
2. **Fetch + verify** the signed publisher manifest: published-apps catalogue, each
   app's `latestVersion`, the `latestCoreVersion` (shared runtime), and the
   common-masters bundle revision.
3. **Diff** against installed app versions, the installed shared-runtime version, and
   the applied masters revision (anti-downgrade tracked **per namespace**).
4. **Confirm → background download → apply** per the hot-reload / next-launch rule.

### 7.3 Published-apps registry (`common:app`)

A core-owned common master listing every published app. Catalogue half (signed,
shared, downloaded once): `appId`, `name`, `tagline`, `description`, `icon`,
`marketingUrl`, `downloadLinks` (per platform), `latestVersion`, `latestCoreVersion`.
**Client-local** half (in the shared suite manifest, never uploaded — receive-only):
`installed`, `installedVersion`, `phoneSyncEnabled`. Keyed by `common:app`; drives the
suite launcher / "more from this publisher" surface and what can be installed and
sync-enabled on this client.

### 7.4 Shared-dir layout additions

Extends §5.1. The shared suite dir additionally holds the shared-runtime bundle and the
updater/registry state:

```
…/SharedCoreLib/core/
   ├─ manifest.json     # { core_version, owners[], lastCheckedAt, lease, apps:{<id>:{installed,installedVersion,phoneSyncEnabled}} }
   ├─ runtime/          # the shared-runtime library bundle (compiled JS), hot-reloaded
   ├─ masters/          # shared OTA reference-data cache (incl. common:app catalogue)
   ├─ bin/  └─ models/   # shared native sidecars / ML models (if any)
```

### 7.5 Install-once / reuse

Folds into `ensure_shared_core` (§5.2). First app downloaded lays down `runtime/` +
`masters/` + the registry; later apps (even installed directly from the web) detect the
shared dir, register in `owners[]`, and reuse everything. Refcounted uninstall (§5.3) is
unchanged: the shared dir is removed only when `owners[]` empties, so removing one app
never breaks another.

### 7.6 App marketplace / launcher (the "More" surface)

`createAppCatalog(config)` turns the §7.3 registry into the user-facing marketplace every
app mounts (a store-like icon, under "More" on mobile): it lists **all** published apps —
**installed and not** — so users can discover and manage the whole suite from inside any
one app. The lib provides data + actions; the app renders the UI (DI, no module state):

- `list()` / `listInstalled()` / `listAvailable()` — registry rows joined with this
  client's per-app-private local state; each `AppCatalogEntry` carries `isCurrentApp`,
  `updateAvailable`, the platform-resolved `downloadUrl`, and a **`primaryAction`**
  (`"open"` | `"download"` | `"current"`).
- **Click behavior** — `activate(appId)` dispatches by state: an **installed** app shows an
  installed badge and **opens/launches** (`open` → injected `launchApp` deep-link / OS
  launch); a **not-installed** app **downloads** (`install` → `openExternal` the platform
  installer link, the **OS** performs the install, and the new app's own bootstrap (§5.2)
  flips its `installed` state); the **current** app is a no-op. `openMarketing` opens the
  marketing page; `markUninstalled` / `setPhoneSync` record local-state changes.

App config supplies: `currentAppId`, `listPublishedApps` (read the shared registry),
`getLocalState`/`setLocalState` (per-app-private, never uploaded), `openExternal` +
`launchApp` (native), and an optional `platform()`. Install/launch are **OS-mediated** —
the catalog surfaces links + state; it never sideloads. Feed-supplied
`downloadLinks`/`marketingUrl` should be origin-allow-listed before opening (THREAT_MODEL §7).

---

## 8. Shared suite database + schema registry

The suite runs **one shared client-side database** (in the shared suite dir, alongside the
masters cache and registry) instead of N isolated app DBs. Goals: **no data duplication**
(the same data lives once), apps can **read each other's data** under governance, and a
**published app's schema is checked + merged** so two apps can't silently diverge on the
same table.

### 8.1 Tables: per-app + common

- **Per-app tables** — owned by one app, qualified by its namespace; other apps read them
  only if confidentiality allows (§8.4). The owning app writes.
- **Common tables** (`shared: true`, `owner: "common"` or a designated owner) — a SINGLE
  copy of data many apps use (the dedup win). Defined once; every entitled app reads.

### 8.2 Semantic schema (`sharedcorelib/schema`)

Every table is a {@link SchemaDescriptor}: `namespace`, `name`, `schemaType`,
`confidentiality`, `purpose`, `owner`, `shared`, plus per-**field** (`dataType`,
`description`, `purpose`, `confidentiality`, **`personalData`** (DPDP), `editability`,
`keyField`, `index`, `constraints`) and per-**relationship** (`relationshipType`,
`relatedSchema`, `embedded`, `reverseName`, …) metadata. Modeled on the suite
`schemata` meta-schema. The registry stores this for **all** data — it is the catalogue +
governance source of truth.

### 8.3 Publish-time check + merge

On publish, the app's schema manifest is checked against the registered schemas
(`checkAgainstRegistry`):

- **new** → registered; **identical** → no-op; **additive** (new fields/relationships) →
  auto-`mergeIntoRegistry`; **incompatible** (field-type change, key change,
  confidentiality downgrade, personal-data flip, relationship change, schema-kind change)
  → a **reported conflict that blocks the publish** until resolved.
- **Duplicate candidates** — a proposed table whose Name + field shape matches an existing
  one under a different owner is flagged so the publisher converts it to a **common** table
  instead of duplicating the data.

This is enforced at the consumer's build stage by `publisher-ci`'s **`schema-merge`** check
(validates the manifest incl. DPDP, conflict-checks against a committed registry snapshot;
the authoritative engine is `sharedcorelib/schema`).

### 8.4 Access governance

`confidentiality` (`Public < Internal < Confidential < Restricted < Secret`) on the schema
and per field governs **cross-app reads** of the shared DB; a field's level overrides the
schema's. **`personalData`** marks DPDP personal data — it must not be `Public` and needs a
`purpose`. The shared DB sits on the **user-writable shared dir** (untrusted disk, see
THREAT_MODEL §4) so integrity-sensitive reads must not assume tamper-freedom.

### 8.5 What stays per-app

The **vault** (per-app Argon2 salt) and app **secrets/settings** remain strictly isolated
(§5.6). Only the application data DB is shared.

> Status: implemented + tested — the **schema engine** (`/schema`: descriptor + validate +
> conflict/merge + duplicate detection), the **publish-time gate** (`publisher-ci`
> `schema-merge`), AND the **runtime DB layer** (`/db`: DDL generation, on-disk registry with
> append-only migrate + conflict-block, confidentiality-governed `read`/`write`/`list`). What
> remains is app-side wiring: inject the Tauri `SqlDb`, call `registerSchemas` at
> install/publish, and resolve each app's granted confidentiality level.
