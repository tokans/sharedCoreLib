/**
 * Lazily-loaded common city seed — split out of `common.ts` so the 600KB+
 * `cities.seed.json` is reachable ONLY through a dynamic `import()` and therefore lands
 * in its own async chunk. A consumer that never shows a city picker (e.g. myHealth) never
 * downloads or parses it; a consumer that does pays for it only when it prewarms.
 *
 * This is purely a bundle-size optimization — the data and shape are unchanged.
 */
import type { MasterOption } from "./index.js";

/** The city seed is keyed by country code → array of city names. */
type CitySeed = Record<string, string[]>;

let seedCache: CitySeed | null = null;
let inFlight: Promise<CitySeed> | null = null;

function toOptions(seed: CitySeed, parent: string | null): MasterOption[] {
  if (!parent) return [];
  return (seed[parent] ?? []).map((c) => ({ value: c, label: c, source: "baked" as const }));
}

/**
 * Load (and cache) the common city seed. The ONLY place the heavy JSON is referenced —
 * via dynamic import, so bundlers isolate it into an async chunk. Idempotent + dedupes
 * concurrent calls. Call this once before city pickers are shown (the sync accessor
 * below returns [] until it resolves).
 */
export async function loadCommonCities(): Promise<CitySeed> {
  if (seedCache) return seedCache;
  inFlight ??= import("./data/cities.seed.json", { with: { type: "json" } }).then((mod) => {
    seedCache = ((mod as { default?: unknown }).default ?? mod) as CitySeed;
    inFlight = null;
    return seedCache;
  });
  return inFlight;
}

/** Parent-scoped baked cities for a country code, loading the seed on demand. */
export async function getBakedCities(parent: string | null): Promise<MasterOption[]> {
  if (!parent) return [];
  return toOptions(await loadCommonCities(), parent);
}

/**
 * Synchronous peek — returns [] until {@link loadCommonCities} has resolved at least once.
 * Lets a sync API (e.g. `getCommonBaked("city")`) keep its signature while the heavy seed
 * stays lazy; callers prewarm via `loadCommonCities()`.
 */
export function getBakedCitiesSync(parent: string | null): MasterOption[] {
  if (!seedCache) return [];
  return toOptions(seedCache, parent);
}
