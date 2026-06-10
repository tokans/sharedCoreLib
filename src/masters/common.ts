/**
 * Common masters + namespacing — the app-agnostic reference sets every suite app
 * shares, and the key convention that keeps a SHARED store conflict-free.
 *
 * ── Why namespacing ──────────────────────────────────────────────────────────
 * When the L2 layer is shared across apps (the OTA masters cache, or a common
 * masters DB), master ids must be qualified by a SCOPE so there are no name or
 * search conflicts:
 *   - `common:<id>`  — reference data owned by the core, reused by ALL apps
 *                      (country, city, currency, relationship). Defined ONCE here
 *                      instead of being recreated in each app.
 *   - `<appId>:<id>` — an app's own masters (e.g. `myfinance:institution`). Two
 *                      apps can both have an `institution` master with no clash,
 *                      and no app can shadow a `common:` master.
 * A lookup/search in any shared store ALWAYS filters by the fully-qualified key,
 * so common and per-app rows never collide. Each app still materialises only the
 * scopes it cares about into its own SQLite (the common scope can additionally be
 * read from the shared store — see CONTRACT.md §5).
 */
import type { MasterOption } from "./index.js";
// JSON import attributes (`with { type: "json" }`) are REQUIRED for Node strict-ESM consumers
// at runtime; without them Node rejects the bare JSON import (it only worked under bundlers).
import countries from "./data/countries.json" with { type: "json" };
import currencies from "./data/currencies.json" with { type: "json" };
import relationships from "./data/relationships.json" with { type: "json" };
import citiesSeed from "./data/cities.seed.json" with { type: "json" };

/** Reserved scope for core-owned reference data shared by every app. */
export const COMMON_SCOPE = "common";

/** Build a fully-qualified, conflict-free master key for a shared store/cache. */
export function qualifyMasterKey(scope: string, id: string): string {
  return `${scope}:${id}`;
}

/** Parse a qualified key; an unqualified key is treated as a common master. */
export function parseMasterKey(key: string): { scope: string; id: string } {
  const i = key.indexOf(":");
  return i < 0
    ? { scope: COMMON_SCOPE, id: key }
    : { scope: key.slice(0, i), id: key.slice(i + 1) };
}

export type CommonMasterId = "country" | "city" | "currency" | "relationship";

/** The common master ids the core owns. Apps reuse these instead of redefining them. */
export const COMMON_MASTER_IDS: readonly CommonMasterId[] = [
  "country",
  "city",
  "currency",
  "relationship",
];

export function isCommonMaster(id: string): id is CommonMasterId {
  return (COMMON_MASTER_IDS as readonly string[]).includes(id);
}

const CITY_SEED = citiesSeed as Record<string, string[]>;

/** Parent-scoped baked cities for a country code (the seed is keyed by country). */
function bakedCitiesFor(parent: string | null): MasterOption[] {
  if (!parent) return [];
  return (CITY_SEED[parent] ?? []).map((c) => ({
    value: c,
    label: c,
    source: "baked" as const,
  }));
}

const COMMON_BAKED: Record<Exclude<CommonMasterId, "city">, MasterOption[]> = {
  country: countries as MasterOption[],
  currency: currencies as MasterOption[],
  relationship: relationships as MasterOption[],
};

/**
 * Baked options for a common master, resolving parent-scoped sets (cities ←
 * country code). This is the SINGLE source of truth for these sets across apps.
 */
export function getCommonBaked(
  id: CommonMasterId,
  parent: string | null = null,
): MasterOption[] {
  if (id === "city") return bakedCitiesFor(parent);
  return COMMON_BAKED[id];
}
