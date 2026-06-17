/**
 * Content-library framework — app-agnostic (promoted from myHealth).
 *
 * A reusable "folder-driven content tabs" mechanism: each content TYPE is one tab
 * (Yoga, Exercises, Recipes, Workouts …) holding ENTRIES (a sequence, a workout)
 * of ordered STEPS (a pose, a movement) with an instruction, an optional hold/
 * duration, and an optional pic. A type ships a few BAKED samples in the app
 * (offline-ready) and pulls richer entries from separately-downloadable, signed
 * bundles published to a GitHub release — both remotely-registered (a NEW tab can
 * appear without an app update) and refreshed by a daily content sync.
 *
 * Provides the MECHANISM only: the model + pure helpers, the zod schemas for OTA
 * payloads, a Zustand store factory, the type-registry merge, and an OTA sync
 * factory built on the masters engine. The APP supplies (via DI): where its
 * content folders live (it runs the `import.meta.glob` and hands the modules to
 * {@link collectBakedTypes}), how to resolve an icon name to its icon component,
 * its release repo/tag + signing public key + transport key, and its tier names.
 * Nothing here knows a single app- or domain-specific id.
 *
 * Receive-only: the sync pulls public signed data and uploads nothing. This is
 * reference content — never authority; apps that surface health/safety content
 * are responsible for their own disclaimers.
 */
import { z } from "zod";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { createOtaUpdater, verifyAndDecryptManifest, genericManifestSchema, type VerifiedEntry } from "../masters/index.js";
import { isTauri } from "../env/index.js";

// Arbitrary-depth folder trees with per-node property files (interim nodes) and
// leaf content — see ./tree.ts. Re-exported so `sharedcorelib/content` is one surface.
export * from "./tree.js";
import type { ContentNode } from "./tree.js";

// ── Model ────────────────────────────────────────────────────────────────────

export type ContentLevel = "beginner" | "intermediate" | "advanced";

export interface ContentStep {
  /** Step / pose / movement name. */
  title: string;
  /** What to do, in plain language. */
  instruction: string;
  /** Seconds to hold or perform; omitted for "flow through" steps. */
  durationSec?: number;
  /** Pic: a `data:` URI (baked art) or an https image URL. */
  image?: string;
}

export interface ContentEntry {
  /** Stable id, unique within a type across baked + downloaded. */
  id: string;
  name: string;
  level?: ContentLevel;
  /** Short focus tag, e.g. "Relaxation", "Strength". */
  focus?: string;
  summary: string;
  steps: ContentStep[];
  source: "baked" | "bundle";
  /** Owning bundle id for downloaded entries (undefined for baked). */
  bundleId?: string;
}

/** A downloadable bundle of entries — the unit published to a GitHub release. */
export interface ContentBundle {
  bundleId: string;
  name: string;
  description?: string;
  /** Monotonic revision of this bundle's content. */
  version: number;
  entries: ContentEntry[];
}

/** Serializable type metadata — the shape the remote catalog publishes. */
export interface ContentTypeMeta<Tier extends string = string> {
  key: string;
  label: string;
  /** Icon NAME (resolved to a component by the app for rendering). */
  iconName: string;
  /** Earned tier this tab unlocks at (progressive disclosure). */
  tier: Tier;
  /** Release tag holding this type's downloadable bundles. */
  releaseTag: string;
  description?: string;
  /** Noun for one entry in the UI, e.g. "sequence", "workout". Default "routine". */
  entryNoun?: string;
  /** Sort order among tabs (lower first). Default 100. */
  order?: number;
}

/** A runtime content type — metadata with a resolved icon + baked samples. */
export interface ContentType<Icon = unknown, Tier extends string = string> {
  key: string;
  label: string;
  icon: Icon;
  tier: Tier;
  releaseTag: string;
  description?: string;
  entryNoun: string;
  order: number;
  /** Baked sample entries shipped in the app (empty for remote-only types). */
  samples: ContentEntry[];
  /**
   * Optional SUBTYPE tree for a nested type (e.g. Yoga → Morning / Wind-down).
   * When present, the content page navigates it (breadcrumb + next-node dropdown)
   * and `samples` are typically empty (entries live at the tree's leaves).
   */
  tree?: ContentNode;
  /** Where the type was registered from. */
  source: "baked" | "remote";
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** A step's displayable image (already a `data:`/https URL, or undefined). */
export function stepImage(step: ContentStep): string | undefined {
  return step.image;
}

/** Total of all step durations, in seconds (missing durations count as 0). */
export function totalDurationSec(entry: ContentEntry): number {
  return entry.steps.reduce((sum, s) => sum + (s.durationSec ?? 0), 0);
}

/** Human "Xm Ys" / "Ys" label for a duration in seconds. */
export function formatDuration(totalSec: number): string {
  if (totalSec <= 0) return "—";
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

/**
 * Merge baked samples with downloaded-bundle entries. Baked come first; a
 * downloaded entry whose id collides with an already-seen one is dropped (baked
 * wins, mirroring the masters merge precedence). Stable + deterministic.
 */
export function mergeEntries(baked: ContentEntry[], downloaded: ContentEntry[]): ContentEntry[] {
  const seen = new Set<string>();
  const out: ContentEntry[] = [];
  for (const entry of [...baked, ...downloaded]) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

/** Distinct `focus` tags across the given entries, in first-seen order. */
export function focusTags(entries: ContentEntry[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.focus || seen.has(e.focus)) continue;
    seen.add(e.focus);
    out.push(e.focus);
  }
  return out;
}

/** Flatten a type's downloaded bundles into entries tagged with source/bundleId. */
export function bundleEntries(bundles: ContentBundle[]): ContentEntry[] {
  return bundles.flatMap((b) =>
    b.entries.map((e) => ({ ...e, source: "bundle" as const, bundleId: b.bundleId })),
  );
}

// ── OTA payload schemas (validated AFTER verify + decrypt) ────────────────────

const stepSchema = z.object({
  title: z.string().min(1).max(120),
  instruction: z.string().min(1).max(2000),
  durationSec: z.number().int().positive().max(36000).optional(),
  // Only raster data: URIs or https images — never javascript:/http:, and never
  // SVG (it can embed <script>, which executes in CSS/<object>/<use> contexts).
  image: z
    .string()
    .max(2_000_000)
    .regex(/^(data:image\/(png|jpe?g|gif|webp|avif);|https:\/\/)/)
    .optional(),
});

/** Zod schema for one content entry (exported for the tree leaf-content coercion). */
export const entrySchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  level: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  focus: z.string().max(80).optional(),
  summary: z.string().min(1).max(600),
  steps: z.array(stepSchema).min(1).max(80),
});

export const contentBundleSchema = z.object({
  bundleId: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(600).optional(),
  version: z.number().int().nonnegative(),
  entries: z.array(entrySchema).min(1).max(300),
});

export const contentTypeMetaSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9-]+$/),
  label: z.string().min(1).max(40),
  iconName: z.string().min(1).max(40),
  // Tier is an app-specific name; validate as a non-empty string here.
  tier: z.string().min(1).max(40),
  releaseTag: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  entryNoun: z.string().max(24).optional(),
  order: z.number().int().min(0).max(999).optional(),
});

// ── Registry merge ───────────────────────────────────────────────────────────

/** Collect the default-exported types from an `import.meta.glob` map, sorted for display. */
export function collectBakedTypes<Icon, Tier extends string>(
  modules: Record<string, { default: ContentType<Icon, Tier> }>,
): ContentType<Icon, Tier>[] {
  return Object.values(modules)
    .map((m) => m.default)
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

/** Resolve a remote catalog entry into a runtime type (no baked samples). */
function fromMeta<Icon, Tier extends string>(
  meta: ContentTypeMeta<Tier>,
  resolveIcon: (name: string) => Icon,
): ContentType<Icon, Tier> {
  return {
    key: meta.key,
    label: meta.label,
    icon: resolveIcon(meta.iconName),
    tier: meta.tier,
    releaseTag: meta.releaseTag,
    description: meta.description,
    entryNoun: meta.entryNoun || "routine",
    order: meta.order ?? 100,
    samples: [],
    source: "remote",
  };
}

/** Merge baked + remote types (baked wins a key collision), sorted for display. */
export function mergeTypes<Icon, Tier extends string>(
  baked: ContentType<Icon, Tier>[],
  remote: ContentTypeMeta<Tier>[],
  resolveIcon: (name: string) => Icon,
): ContentType<Icon, Tier>[] {
  const byKey = new Map<string, ContentType<Icon, Tier>>();
  for (const t of baked) byKey.set(t.key, t);
  for (const m of remote) if (!byKey.has(m.key)) byKey.set(m.key, fromMeta(m, resolveIcon));
  return [...byKey.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

/** Look up a type by key from a resolved list. */
export function findContentType<Icon, Tier extends string>(
  types: ContentType<Icon, Tier>[],
  key: string | undefined,
): ContentType<Icon, Tier> | undefined {
  return types.find((t) => t.key === key);
}

// ── Store factory ────────────────────────────────────────────────────────────

/** Live downloaded-content state for one app (one tab per content type). */
export interface ContentStoreState<Tier extends string = string> {
  /** INSTALLED bundles (active in the content list), per content-type key. */
  bundlesByType: Record<string, ContentBundle[]>;
  /** AVAILABLE bundles known from the latest signed manifest (the install catalog), per type. */
  availableByType: Record<string, ContentBundle[]>;
  /** Applied bundle-manifest revision (informational), per type key. */
  revisionByType: Record<string, number>;
  /** Remotely-registered content types (so a new tab can appear without an app update). */
  remoteTypes: ContentTypeMeta<Tier>[];
  /** Applied catalog revision (informational). */
  catalogRevision: number;
  /** Epoch ms of the last daily sync (throttle). */
  lastCheckedAt: number;
  /** Replace the AVAILABLE catalog for a type (what the user can install). */
  setAvailable: (typeKey: string, bundles: ContentBundle[]) => void;
  /** Install one available bundle (available → installed) by id. No-op if not available. */
  installBundle: (typeKey: string, bundleId: string) => void;
  /** Insert/replace an INSTALLED bundle directly (latest version wins). */
  upsertBundle: (typeKey: string, bundle: ContentBundle) => void;
  /** Uninstall a bundle (remove from installed; it stays in the available catalog). */
  removeBundle: (typeKey: string, bundleId: string) => void;
  /** Record the applied bundle-manifest revision for a type. */
  setRevision: (typeKey: string, revision: number) => void;
  /** Register/replace a remotely-discovered content type (by key). */
  registerRemoteType: (meta: ContentTypeMeta<Tier>) => void;
  /** Record the applied catalog revision. */
  setCatalogRevision: (revision: number) => void;
  /** Stamp the last daily-sync time (epoch ms). */
  markChecked: (at: number) => void;
}

export interface ContentStoreConfig {
  /** localStorage key the bundles/revisions/catalog state persists under. */
  storageKey: string;
}

interface Persisted<Tier extends string> {
  bundlesByType: Record<string, ContentBundle[]>;
  availableByType: Record<string, ContentBundle[]>;
  revisionByType: Record<string, number>;
  remoteTypes: ContentTypeMeta<Tier>[];
  catalogRevision: number;
  lastCheckedAt: number;
}

function emptyPersisted<Tier extends string>(): Persisted<Tier> {
  return { bundlesByType: {}, availableByType: {}, revisionByType: {}, remoteTypes: [], catalogRevision: 0, lastCheckedAt: 0 };
}

/**
 * Build a Zustand store of downloaded content, persisted to localStorage under
 * `cfg.storageKey`. Content is public, non-sensitive reference data (no PII), so
 * localStorage is appropriate and avoids a DB migration. Receive-only: written
 * solely by the verified OTA apply step ({@link createContentSync}).
 */
export function createContentStore<Tier extends string = string>(
  cfg: ContentStoreConfig,
): UseBoundStore<StoreApi<ContentStoreState<Tier>>> {
  const read = (): Persisted<Tier> => {
    try {
      const raw = globalThis.localStorage?.getItem(cfg.storageKey);
      if (!raw) return emptyPersisted<Tier>();
      return { ...emptyPersisted<Tier>(), ...(JSON.parse(raw) as Partial<Persisted<Tier>>) };
    } catch {
      return emptyPersisted<Tier>();
    }
  };

  return create<ContentStoreState<Tier>>((set, get) => {
    const write = () => {
      const s = get();
      try {
        globalThis.localStorage?.setItem(
          cfg.storageKey,
          JSON.stringify({
            bundlesByType: s.bundlesByType,
            availableByType: s.availableByType,
            revisionByType: s.revisionByType,
            remoteTypes: s.remoteTypes,
            catalogRevision: s.catalogRevision,
            lastCheckedAt: s.lastCheckedAt,
          } satisfies Persisted<Tier>),
        );
      } catch {
        /* ignore quota / privacy-mode errors */
      }
    };
    // Coalesce persistence onto a microtask so a sync that fires many setters in one
    // tick (setAvailable + N upsertBundle …) serializes the whole store ONCE, not
    // O(types · bundles) times. Readers see updates synchronously (set is immediate);
    // only the localStorage mirror is deferred — and it always writes the latest state.
    let scheduled = false;
    const persist = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        write();
      });
    };

    const upsertInstalled = (typeKey: string, bundle: ContentBundle) => {
      const existing = get().bundlesByType[typeKey] ?? [];
      const next = [...existing.filter((b) => b.bundleId !== bundle.bundleId), bundle];
      return { ...get().bundlesByType, [typeKey]: next };
    };

    const update = <K extends keyof ContentStoreState<Tier>>(patch: Pick<ContentStoreState<Tier>, K>) => {
      set(patch);
      persist();
    };

    return {
      ...read(),
      setAvailable: (typeKey, bundles) =>
        update({ availableByType: { ...get().availableByType, [typeKey]: bundles } }),
      installBundle: (typeKey, bundleId) => {
        const bundle = (get().availableByType[typeKey] ?? []).find((b) => b.bundleId === bundleId);
        if (bundle) update({ bundlesByType: upsertInstalled(typeKey, bundle) });
      },
      upsertBundle: (typeKey, bundle) => update({ bundlesByType: upsertInstalled(typeKey, bundle) }),
      removeBundle: (typeKey, bundleId) => {
        const next = (get().bundlesByType[typeKey] ?? []).filter((b) => b.bundleId !== bundleId);
        update({ bundlesByType: { ...get().bundlesByType, [typeKey]: next } });
      },
      setRevision: (typeKey, revision) =>
        update({ revisionByType: { ...get().revisionByType, [typeKey]: revision } }),
      registerRemoteType: (meta) =>
        update({ remoteTypes: [...get().remoteTypes.filter((t) => t.key !== meta.key), meta] }),
      setCatalogRevision: (catalogRevision) => update({ catalogRevision }),
      markChecked: (lastCheckedAt) => update({ lastCheckedAt }),
    };
  });
}

// ── OTA sync factory (catalog + per-type bundles) ────────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface ContentSyncConfig<Tier extends string = string> {
  /** The store created by {@link createContentStore}. */
  store: UseBoundStore<StoreApi<ContentStoreState<Tier>>>;
  /** Current content types (baked ⊕ remote) — the app's registry provides this. */
  listTypes: () => Array<{ key: string; releaseTag: string }>;
  /** GitHub-releases download base URL; the per-tag path is appended. */
  baseUrl: string;
  /** Release tag holding the signed remote type catalog. */
  catalogTag: string;
  pubkeyHex: string;
  transportKeyB64: string;
  /** This binary's version, gated against each manifest's `minAppVersion`. */
  appVersion: string;
  /** Manifest filename under each tag. Default "content.manifest.json". */
  manifestFile?: string;
  /** Throttle window for the daily sync. Default 24h. */
  throttleMs?: number;
  /** Whether sync is enabled. Default: signing keys present. */
  enabled?: () => boolean;
  /**
   * Inject a byte fetcher to run OUTSIDE Tauri — e.g. a `window.fetch` wrapper for
   * a BROWSER dev preview. When provided, the same verify→decrypt→apply runs over
   * it (via `verifyAndDecryptManifest`) instead of the Tauri-HTTP `createOtaUpdater`.
   * The dev/static server must send permissive CORS. Omit in production (Tauri).
   */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
}

export interface ContentSync {
  /** True if sync is configured (signing keys present). */
  isConfigured(): boolean;
  /** True if sync can actually run now (configured AND in Tauri OR a `fetchBytes` is injected). */
  canRun(): boolean;
  /**
   * Run one sync: refresh the remote catalog, then check every known type's
   * bundles. Best-effort + fail-silent. Throttled to `throttleMs` unless `force`.
   * Returns true if anything was applied.
   */
  runContentSync(opts?: { force?: boolean }): Promise<boolean>;
  /** Force-check one content type's bundles (a "Check now" button). */
  checkTypeNow(type: { key: string; releaseTag: string }): Promise<boolean>;
}

/**
 * Build a content OTA sync bound to one app's release + keys + store. Mirrors the
 * masters engine: each pass is Ed25519 verify → revision/app-version gate →
 * per-file SHA-256 → AES-256-GCM decrypt → zod-validate → store. Receive-only.
 */
export function createContentSync<Tier extends string = string>(cfg: ContentSyncConfig<Tier>): ContentSync {
  const manifestFile = cfg.manifestFile ?? "content.manifest.json";
  const throttleMs = cfg.throttleMs ?? ONE_DAY_MS;
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const isConfigured = () => (cfg.enabled ? cfg.enabled() : !!cfg.pubkeyHex && !!cfg.transportKeyB64);
  const canRun = () => isConfigured() && (isTauri() || !!cfg.fetchBytes);

  /** One verify→decrypt→apply pass over a release tag. Tauri path or injected-fetch (browser) path. */
  const runOne = async (
    tag: string,
    getLastRevision: () => Promise<number>,
    applyEntry: (e: VerifiedEntry) => Promise<void>,
    onApplied: (rev: number) => void,
  ): Promise<boolean> => {
    const tagBase = `${base}/${tag}`;
    // Inside Tauri always use the Tauri-HTTP updater (the webview's own fetch is
    // CSP-bound); the injected `fetchBytes` is the BROWSER-only dev path.
    if (cfg.fetchBytes && !isTauri()) {
      const fb = cfg.fetchBytes;
      try {
        const [manifestBytes, sigFile] = await Promise.all([
          fb(`${tagBase}/${manifestFile}`),
          fb(`${tagBase}/${manifestFile}.sig`),
        ]);
        const { manifest, entries } = await verifyAndDecryptManifest(manifestBytes, b64ToBytes(textTrim(sigFile)), {
          fetchFile: (file) => fb(`${tagBase}/${file}`),
          pubkeyHex: cfg.pubkeyHex,
          transportKeyB64: cfg.transportKeyB64,
          manifestSchema: genericManifestSchema,
          lastRevision: await getLastRevision(),
          appVersion: cfg.appVersion,
        });
        for (const e of entries) await applyEntry(e);
        if (entries.length) onApplied(manifest.revision);
        return entries.length > 0;
      } catch (e) {
        console.debug("content sync (browser) skipped:", e);
        return false;
      }
    }
    return createOtaUpdater({
      baseUrl: tagBase,
      manifestFile,
      pubkeyHex: cfg.pubkeyHex,
      transportKeyB64: cfg.transportKeyB64,
      manifestSchema: genericManifestSchema,
      enabled: isConfigured,
      getAppVersion: async () => cfg.appVersion,
      getLastRevision,
      applyEntry,
      onApplied,
    }).runUpdate({ force: true });
  };

  const catalogPass = () =>
    runOne(
      cfg.catalogTag,
      async () => cfg.store.getState().catalogRevision,
      async (entry) =>
        cfg.store.getState().registerRemoteType(contentTypeMetaSchema.parse(entry.payload) as ContentTypeMeta<Tier>),
      (rev) => cfg.store.getState().setCatalogRevision(rev),
    );

  const typePass = async (type: { key: string; releaseTag: string }) => {
    // Decrypt the whole manifest into the AVAILABLE catalog (what the user can
    // install). Content has no anti-rollback (pass lastRevision 0) so the catalog
    // always refreshes — a user-removed bundle reappears as available, re-addable.
    const collected: ContentBundle[] = [];
    const applied = await runOne(
      type.releaseTag,
      async () => 0,
      async (entry) => {
        const parsed = contentBundleSchema.parse(entry.payload);
        collected.push({
          bundleId: parsed.bundleId,
          name: parsed.name,
          description: parsed.description,
          version: parsed.version,
          entries: parsed.entries.map((e) => ({ ...e, source: "bundle" as const, bundleId: parsed.bundleId })),
        });
      },
      (rev) => cfg.store.getState().setRevision(type.key, rev),
    );
    if (collected.length) {
      const st = cfg.store.getState();
      st.setAvailable(type.key, collected);
      // Keep already-installed bundles updated to the latest version (don't auto-install new ones).
      const installed = new Set((st.bundlesByType[type.key] ?? []).map((b) => b.bundleId));
      for (const b of collected) if (installed.has(b.bundleId)) cfg.store.getState().upsertBundle(type.key, b);
    }
    return applied;
  };

  const isDue = (force: boolean) =>
    force || Date.now() - cfg.store.getState().lastCheckedAt >= throttleMs;

  return {
    isConfigured,
    canRun,
    runContentSync: async (opts = {}) => {
      const force = opts.force ?? false;
      if (!canRun() || !isDue(force)) return false;
      let applied = await catalogPass();
      for (const type of cfg.listTypes()) {
        applied = (await typePass(type)) || applied;
      }
      cfg.store.getState().markChecked(Date.now());
      return applied;
    },
    checkTypeNow: async (type) => {
      if (!canRun()) return false;
      const applied = await typePass(type);
      cfg.store.getState().markChecked(Date.now());
      return applied;
    },
  };
}

/** Base64 → bytes (browser + Node via `atob`). */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const textTrim = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).trim();
