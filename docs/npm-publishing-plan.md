# Plan: publish sharedCoreLib to public npm (retire `file:../` consumption)

**Status:** planned, not started. **Decided:** publish to **public npm** (unscoped).
**Why:** every CI workflow in every consumer (`release.yml`, `security.yml`) currently
has to check out the sibling repos with a `PUBLISH_TOKEN` just so `npm ci` can resolve
`file:../sharedCoreLib`, `file:../sharedCoreLib/publisher-ci`, and `file:../myDemo`.
That friction caused two CI breakages already (the security-gate E404). Publishing to a
registry removes the sibling-checkout dance entirely.

## Pre-flight facts (verified 2026-06-13)
- `sharedcorelib` and `sharedcorelib-publisher-ci` are **both free on public npm** → keep
  them **unscoped**. This means **no import changes** in any consumer (`import "sharedcorelib/env"`
  keeps working; the dependency just resolves from the registry instead of a symlink).
- `sharedCoreLib/package.json` is currently `private: true`, has **no `files`**, no
  `main`/`types`, `type: module`, and a subpath `exports` map. `version: 0.4.0`.
- `publisher-ci/package.json` is `private: false`, `version: 0.1.0`, has a `bin`
  (`sharedcorelib-publisher-ci` → `bin/cli.mjs`).
- The repo `tokans/sharedCoreLib` is **private** (CI needs a PAT to read it) — publishing
  the *compiled package* publicly is the accepted trade-off (user chose public npm).

## ⚠️ The load-bearing gotcha: consumers Tailwind-scan core SOURCE
Apps add `../sharedCoreLib/src/ui/**/*.{ts,tsx}` to their Tailwind `content` globs and import
`sharedcorelib/tailwind-preset` + `sharedcorelib/ui/theme.css`. So the published tarball
**must ship the `src/ui` source**, not just `dist/`. If `files` only includes `dist`, every
consumer's UI loses its Tailwind classes (silent visual breakage). The `files` whitelist must
include `dist/`, the `src/ui` sources Tailwind scans, the preset, and `theme.css`.

## Work items

### A. Make `sharedcorelib` publishable (in sharedCoreLib repo)
1. `package.json`:
   - Remove `private: true`.
   - Add `"publishConfig": { "access": "public" }`.
   - Add an explicit `"files"` whitelist: `["dist", "src/ui", "<tailwind-preset path>", "<theme.css path>"]`
     — confirm exact paths the `exports` map + Tailwind globs resolve to. Err toward shipping
     all of `src` if pruning is risky.
   - Add `"prepublishOnly": "npm run build && npm run test"` so `dist/` is always fresh + green.
   - Verify the `exports` map entries all point at built `dist/*` files (and `.d.ts` types).
   - Set `repository`, `license`, `homepage`.
2. Confirm a clean `npm pack` tarball contains dist + the UI source + preset + theme.css
   (`npm pack --dry-run` and inspect the file list). This is the single most important check.
3. Keep heavy deps (`react`, `zod`, `zustand`, `@noble/*`, Tauri plugins) as **peerDependencies**
   (already the case) — consumers provide the single copy. Unchanged.

### B. Make `publisher-ci` publishable
- Already `private: false` with a `bin`. Add `publishConfig.access: public`, a `files`
  whitelist (`bin`, `lib`/`src`, templates it scaffolds), and `prepublishOnly` if it has a build.
- It versions independently (0.1.0). Decide whether one workflow publishes both packages or each
  publishes on its own tag.

### C. Publish workflow(s) in `tokans/sharedCoreLib`
- New GH Actions workflow, trigger on `v*` tag (or GitHub Release):
  `checkout → setup-node (registry-url: https://registry.npmjs.org) → npm ci → build → test →
   npm publish --access public` for sharedcorelib, and the same for publisher-ci.
- Add `NPM_TOKEN` (npmjs **automation** token) as a repo secret; expose as `NODE_AUTH_TOKEN`.
- Gate publish on tests passing. Use `npm publish --dry-run` first time.

### D. Migrate consumers (myFinance first, then myHealth + future apps)
1. `package.json`: `"sharedcorelib": "^0.4.0"`, `"sharedcorelib-publisher-ci": "^0.1.0"`
   (replace the two `file:../` specifiers).
2. **Remove the `prebuild` script** (`npm --prefix ../sharedCoreLib run build`) — the published
   package ships built `dist/`.
3. `tailwind.config.cjs`: change the content glob from `../sharedCoreLib/src/ui/**` to
   `./node_modules/sharedcorelib/src/ui/**/*.{ts,tsx}`. Verify classes still emit.
4. **Keep** `vite.config.ts` `resolve.dedupe` (still cheap insurance for a single React; a real
   registry dep dedupes more naturally than the old symlink, but leave it).
5. CI (`release.yml`, `security.yml`): **delete the sharedCoreLib + publisher-ci sibling
   checkout steps** and the `npm ci` in sharedCoreLib. Public npm needs no auth for install.
6. Re-run the full deploy gate (`docs/release-checklist.md`) — G6 (`publisher-ci check`) now runs
   straight from the registry-installed binary.

### E. `@mydemo/core` (separate decision, anshumandas/myDemo)
- Still a `file:../myDemo` **devDependency**, so `npm ci` in CI still needs it present even after
  A–D — the build (`vite`/`tsc`/`tauri`) installs devDeps. Options:
  (a) publish `@mydemo/core` to public npm too (fully removes all sibling checkouts), or
  (b) keep only the myDemo checkout in CI (it's dev-only/demo capture), or
  (c) move demo deps so `npm ci` for the build path doesn't require it.
- Recommendation: (a) for consistency, but it's independent of the sharedcorelib migration.

### F. Docs / CONTRACT
- Update `sharedCoreLib/CONTRACT.md` §1–2 (currently documents `file:../` + subpath exports) to
  describe registry consumption (subpath exports unchanged, peerDeps unchanged).
- Update `myLife/CLAUDE.md`, `myFinance/CLAUDE.md` (the `file:../` + `prebuild` descriptions).
- Update `myLife/BUILD-STATUS.md`.

### G. Local development workflow after the switch
- Editing core no longer auto-rebuilds into an app. For active core work, use `npm link
  sharedcorelib` (or a local `overrides`) in the app, documented in CLAUDE.md. Normal app work
  just consumes the published version.

## Rollout order
1. A + B + C → publish `sharedcorelib@0.4.x` and `sharedcorelib-publisher-ci@0.1.x` (dry-run first).
2. D in **myFinance**; verify `npm run build`, `npm run test`, and both CI workflows green.
3. Repeat D for siblings (myHealth, …) — **fold in the `resolve.dedupe` rollout** (see below).
4. E + F + G.

## Risks
- **Tailwind source shipping** (the §gotcha) — verify via `npm pack` file list before first publish.
- Public exposure of compiled core — accepted (user chose public npm).
- Version drift between core and apps — semver discipline; apps pin `^`.
- First publish is irreversible per (name@version); use `--dry-run` and a `0.4.x` test bump.

---

## Related deferred tasks (carry into the same session)
- **`resolve.dedupe` rollout to sibling apps** (myHealth + future `sharedcorelib` consumers). Root
  cause + fix documented in myFinance memory `project-dedupe-react-symlink.md`. Do this as part of
  step 3 above, since both touch each consumer's `vite.config.ts`.
- **Error-boundary stack verbosity** (myFinance `RootErrorBoundary.tsx`): the full on-screen stack
  is intentionally verbose for now; decide whether to gate it behind a debug toggle long-term.
- **G12 installer code-signing** (Authenticode on Windows, Apple Developer ID + notarization on
  macOS) to stop SmartScreen/Gatekeeper warnings — declared `[WARN]` in the release checklist.
