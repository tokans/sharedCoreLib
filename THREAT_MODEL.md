# sharedcorelib — security model & threat model

How the suite defends itself, the trust boundaries it draws, and the residual risks
it accepts. This is the **canonical security reference**; the hardening controls here
are mechanically enforced at each consuming app's dev/CI stage by the
[`publisher-ci`](./publisher-ci) toolkit (a dev-dependency, **not** shipped in the
downloadable runtime).

> Status: the `sharedcorelib/suite` verification **engine** (delegation-chain verify,
> anti-rollback, freshness, verify-at-load) is implemented and unit-tested; the crypto
> hygiene controls (§5) are applied in `src/crypto` + `src/vault`. Items still marked ⏳
> are runtime wiring the app supplies (the on-device hot-swap, lease, native confirm UI)
> or operational process (key ceremony, transparency log). The `publisher-ci` toolkit
> enforces what is statically checkable and fails the build when an app drifts.

---

## 0. Why this matters

The shared runtime is a **downloaded, hot-reloaded, executable** L2 asset loaded into a
privileged Tauri webview (FS + Stronghold vault + HTTP + OS plugins), shared by **every
installed app**. That makes the updater a software-supply-chain channel whose blast
radius is *all apps on the machine*. The controls here treat the updater with the rigor
of a code-signing / secure-update system, not a data feed.

---

## 1. Trust boundaries

| # | Boundary | Untrusted side | Control |
|---|---|---|---|
| B1 | Publisher feed → client | the network + the feed/CDN | TUF-style signed metadata, baked root key, verify-before-use |
| B2 | Shared suite dir (disk) → app runtime | the on-disk bytes (any same-user process can write them) | **everything on disk is untrusted; re-verify signatures at load** |
| B3 | Downloaded runtime JS → execution | the staged bundle | verify-at-load + atomic swap + quiesce/lock vault |
| B4 | Peer device → app (sync) | the LAN peer | PAKE-derived envelope + authenticated writer identity |
| B5 | App webview → native shell | the (replaceable) webview | trust decisions + update confirmation live in the **native shell** |
| B6 | Publisher → everyone | a compromised publisher/key | threshold signing + binary transparency (detectability) |

**Single most important reframing:** the *only* roots of trust are the **baked public
keys**. The shared dir, the masters cache, the registry, the lease, and the staged
runtime are all **untrusted input** re-verified on every load. This collapses
"shared-dir poisoning" to "must forge a signature."

---

## 2. Key hierarchy (resolves immutable-anchor vs rotation) ⏳

A single immutable signing key cannot be rotated after compromise. We split roles so the
**immutable** part stays tiny and offline, and operational keys rotate freely.

```
ROOT KEY  (baked into every app build; immutable after install; OFFLINE / HSM)
   │  signs short-lived delegations →
   ├── DATA-SIGNING key   → reference-data masters, published-apps registry  (lower assurance)
   ├── CODE-SIGNING key    → the shared-runtime JS bundle, app content packs  (HIGHER assurance, separate key, k-of-n threshold)
   ├── SNAPSHOT key        → binds the consistent set of artifacts at a revision
   └── TIMESTAMP key       → short-expiry freshness proof (anti-freeze/replay)
```

Rules enforced by `publisher-ci`:

1. **Code-signing ≠ data-signing ≠ root** — distinct keys; code is never signed by the
   data key (compromise of the low-value data key must not yield RCE).
2. **Root is offline** (HSM / air-gapped); the app config declares it as the immutable
   anchor and never reads any anchor from the feed.
3. **Rotation via delegation** — operational keys are rotated by a root-signed
   succession; the immutable root never moves, satisfying "anchor immutable after
   install" while still allowing recovery from a leaked operational key.
4. **New-app onboarding chains to root** — when the user approves a *new* app's download,
   that app's anchor must be **delegated/signed by the immutable publisher root**, not an
   arbitrary key the feed supplies. A hostile feed therefore cannot onboard a rogue app
   under the publisher's brand (closes the registry-driven onboarding attack).

---

## 3. The secure update flow (TUF-modeled) ⏳

Adopted because §2 + rollback + freeze + replay + key rotation are exactly the threat set
[The Update Framework](https://theupdateframework.io/) solves; we model the metadata on
its roles rather than hand-rolling.

1. **Trust anchor** — feed `baseUrl` + root `pubkeyHex` + transport key are **baked** at
   build time. The feed location is recorded as an auditable master and is **add-only on
   approval, immutable thereafter** (an installed app's anchor can never be repointed).
2. **One check per machine per day** — a cross-process lease + `lastCheckedAt` in the
   shared manifest. Other apps **do not trust the checker's verdict**; each re-verifies
   signed artifacts on disk against its baked anchor.
3. **Verify order** (nothing acted on before authentication): root/delegation chain →
   **timestamp freshness (expiry)** → **snapshot monotonic version** (anti-rollback) →
   per-target SHA-256 → AES-GCM transport decrypt → schema parse.
4. **Anti-rollback** — refuse any artifact whose signed monotonic version is below the
   highest ever seen. The floor is protected from local tampering (signed snapshot
   version, not the writable manifest alone).
5. **Anti-freeze / replay** — timestamp metadata has a **short expiry**; stale metadata
   triggers a user-visible warning ("no fresh signed metadata in N days"). Freshness is
   judged against the signed timestamp, **not** the client clock (which is attacker-mutable).
6. **Confirm → background download → apply**:
   - **Verify at load, not just at download** (closes the staging TOCTOU).
   - **Webview/content** (masters, registry, runtime JS, app content pack) →
     **hot-reload live** after an **atomic swap**, having first **quiesced** the app
     (drain the vault op-chain, checkpoint SQLite) and **locked the vault** across the
     swap so freshly-loaded code never inherits in-memory secrets.
   - **Native shell / sidecars** → download in background, **apply on next launch**.
   - A **compatibility gate** prevents pairing a new webview runtime with a not-yet-updated
     native shell (don't call a command the old shell lacks).
   - The **confirmation UI for code updates lives in the native shell**, not the webview
     being replaced (a compromised webview must not be able to spoof its own update prompt).

---

## 4. Shared suite dir (multi-app, user-writable) ⏳

`%LOCALAPPDATA%\SharedCoreLib\core` is writable by any same-user process. Therefore:

- **Verify-at-load everywhere** (B2/B3) — the dir is untrusted; only signatures matter.
- **Security-sensitive client-local state lives per-app-private, not in the shared
  manifest.** In particular `phoneSyncEnabled` (an exfiltration toggle): a co-resident
  malicious app flipping it in a shared writable file is unacceptable, so it lives in each
  app's own private storage. Only non-sensitive coordination (lease, refcount) is shared.
- **Lease robustness** — timeout/steal semantics so a stuck/malicious holder can't freeze
  everyone's updates; the lease is a coordination hint, never a trust decision.

---

## 5. Crypto hygiene (applies to existing code)

| Item | Today | Target |
|---|---|---|
| Export KDF | PBKDF2-HMAC-SHA256 **150k**, format `salt‖iv‖ct` with **no version/params header** | **Versioned header** (algo id + params), then **Argon2id** (align with the vault's Rust side) or PBKDF2 **≥600k** |
| Blob sealing | `iv‖ct`, **no AAD**, no version byte | bind record-id/purpose as **AAD** + add a **version byte** (prevents blob-swap/confusion) |
| Key/id generation | `newCredentialKey` uses `Date.now()+Math.random()` | `crypto.randomUUID()` / CSPRNG (consistent with blob filenames) |
| IV under fixed DEK | random 96-bit, fine at small scale | document the rekey/counter threshold before high-volume sealing |
| Op-chain errors | some swallowed ("continue regardless") | audit each swallow for silent data-loss; surface persistence failures |

`publisher-ci` flags weak KDF params, missing format headers, and non-CSPRNG randomness
in any app that vendors or re-implements these primitives.

---

## 6. Sync (device-to-device) ⏳

- **Pairing entropy** — the LAN envelope must not be keyed by a short pairing code fed to
  PBKDF2 (offline-brute-forceable from captured ciphertext). Use a **PAKE** (SPAKE2/OPAQUE)
  or high-entropy pairing material.
- **Authenticated writer** — LWW (`isNewer`: newer `updated_at`, `device_id` tie-break)
  trusts unauthenticated fields; a malicious peer sets a far-future `updated_at` or a high
  `device_id` to win every merge. Bind merges to an **authenticated device identity** and
  **reject implausible/far-future timestamps**; prefer a hybrid logical clock over wall time.
- **Scope of "receive-only"** — means **no telemetry/exfil to the publisher**; sync is
  LAN peer-to-peer under explicit user control. The two are documented as distinct.

### 6.1 Receive-only backend (relaxation) + the two egress exceptions

The original "no backend" rule is **relaxed to receive-only**: a backend MAY *serve* data
to apps (masters bundles, update-availability, the **donation-completion** and
**partner-status** grants). Apps **only GET; they never upload user data.** Concretely:

- **Grants are verify-only** (`sharedcorelib/grant`): a signed-then-encrypted envelope the
  app receives via a dropped file or an **anonymous claim token** (a donation/enrollment
  reference, not PII). Verify Ed25519 → decrypt AES-GCM → parse. The token is the *only*
  thing the device sends, and it identifies a payment/enrollment, not the user. Grant
  signing keys are **separate** from masters/code keys (grants may be minted online).
- **Two user-initiated egress points live OUTSIDE the apps:** the **donation** (on
  tokans.org — anonymous) and **Partner enrollment** (the user provides professional
  details *on the portal*; the app only receives "you're a Partner"). Neither flows the
  app's local data off-device.
- **`myWorkAssistant` is the explicit carve-out** — a Partner-gated app with its OWN
  backend + auth (full tauri-react-stack + core). It does **not** carry the receive-only
  promise and is clearly marked in the registry (`access: "partner"`, `hasBackend: true`);
  the marketplace surfaces **Enroll / Sign in** for it instead of a plain download.

Everything else stays receive-only. The daily-check phone-home caveats (§7) still apply to
any backend GET: minimize metadata, no per-user identifier beyond an anonymous token, TLS-pin.

### 6.2 Shared database — cross-app access governance

Installed apps share **one client-side DB** (per-app + common tables), so an app can read
another app's data. Controls:

- **Confidentiality governs reads** (`Public < Internal < Confidential < Restricted <
  Secret`, per schema and per field) — an app reads a foreign table only at/below its
  granted level. **`personalData`** (DPDP) fields must not be `Public` and carry a
  `purpose`; the `schema-merge` gate enforces this at publish.
- **Untrusted disk:** the shared DB lives in the user-writable shared dir (§4) — any
  same-user process can tamper it. Treat reads of integrity-sensitive data accordingly;
  secrets never go in the shared DB (they stay in the per-app vault, §5).
- **Schema conflict = blocked publish:** an app cannot silently redefine a shared table's
  field type/key/confidentiality — the publish-time check rejects it, preventing a
  malicious or careless app from widening access or corrupting another app's data shape.
- The **vault stays strictly per-app** — the shared DB relaxation does not touch it.

---

## 7. Privacy / metadata

- **Daily check is a phone-home** — even receive-only, it leaks IP + timing + app + version
  to the feed/CDN. Minimize request metadata, carry **no per-user identifier**, allow a
  longer interval / opt-out, and **pin TLS** to the feed domain (defense-in-depth atop
  payload signatures).
- **Feed-supplied `downloadLinks` / `marketingUrl`** rendered in trusted UI are a
  phishing/malware channel if the feed is compromised — **allow-list origins**, show the
  real domain, and **verify the downloaded installer's own signature** rather than trusting
  the link.

---

## 8. Residual risk (accepted, with mitigations)

A compromised **publisher** (not just a leaked operational key) can still push code to all
clients. This is irreducible in a single-publisher model, but made **detectable**:

- **Threshold (k-of-n) signing** so one leaked key is insufficient.
- **Reproducible builds** so an artifact can be independently rebuilt and compared.
- **Binary transparency** (Sigstore/Rekor-style append-only log) so every update served is
  publicly logged and a malicious one is detectable after the fact.

**CI / publish separation.** Source lives in the dev account; builds, releases and the
gh-pages site are published to a separate **publisher account** (`tokans`) under a repo
named for the source, using a `PUBLISH_TOKEN` PAT scoped to `contents: write` on that repo.
CI builds and publishes binaries but **never holds feed/code signing keys** — the signed
update feed is produced offline and uploaded via `publish-feed.mjs`. So a compromised CI
runner can ship a *binary* (caught by transparency + reproducible builds) but cannot mint a
validly-signed *update* for the suite updater. `release-pipeline` enforces this split.

---

## 9. Control → enforcement map

| Control | Enforced by |
|---|---|
| Key hierarchy, role/key separation, root-offline, new-app delegation | `publisher-ci` `trust-anchor`, `key-separation` checks (validates the app's signed trust manifest) |
| Anti-rollback/freeze metadata present (monotonic version + expiry) | `publisher-ci` `update-metadata` check |
| Deprecation window (3 core versions) honored | `publisher-ci` `deprecation-window` check |
| KDF floor, format header, CSPRNG randomness | `publisher-ci` `kdf-floor` check |
| HTTPS-only / no plaintext feed URLs | `publisher-ci` `tls-only` check |
| Dependency pinning + integrity (supply chain) | `publisher-ci` `dependency-pinning` check |
| Cross-account publish via `PUBLISH_TOKEN`; **no signing keys in CI** (feed signed offline) | `publisher-ci` `release-pipeline` check (validates `.github/workflows/release.yml`) |
| Verify-at-load, quiesce/lock-on-swap, native-owned confirmation | runtime code review (the `sharedcorelib/suite` implementation) |

See [`publisher-ci/README.md`](./publisher-ci/README.md) for how an app wires the toolkit.
