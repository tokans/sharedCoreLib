import { resolveTierOverride } from "../tiers/index.js";

/**
 * Browser plumbing for the dev/test tier override (the pure resolver is in
 * `sharedcorelib/tiers`). The env flags are INJECTED by the app (DI) — the lib never reads
 * `import.meta.env` itself, so the compiled dist carries no build-time globals and the app's
 * Vite stays the single source of `DEV` / `VITE_*`. A URL `?tier=` choice is written through to
 * localStorage so it survives reloads and client-side routing.
 */
export interface TierOverrideEnv {
  /** Dev build? Pass `import.meta.env.DEV`. */
  dev: boolean;
  /** Prod escape hatch — pass `import.meta.env.VITE_ALLOW_TIER_OVERRIDE === "1"`. */
  allowInProd?: boolean;
  /** Optional build-time start tier — pass `import.meta.env.VITE_TIER`. */
  startTier?: string | null;
}

export interface TierOverrideConfig {
  /** Per-app localStorage key, e.g. "mythoughts.tierOverride". */
  storageKey: string;
  /** The app ladder's valid tier keys (an override outside this set is ignored). */
  validKeys: readonly string[];
  env: TierOverrideEnv;
}

export interface TierOverride {
  /** Whether the override is permitted at all (dev build, or the prod escape hatch). */
  allowed(): boolean;
  /** The active override key, or null. Reads URL → localStorage → start tier. */
  get(): string | null;
  /** Persist (or clear, with null) the override. */
  set(key: string | null): void;
}

/** Read `?tier=` from both the real query string and a hash-router query (`#/route?tier=`). */
function urlTier(): string | null {
  if (typeof window === "undefined") return null;
  const fromHash = window.location.hash.includes("?") ? window.location.hash.split("?")[1] : "";
  const params = new URLSearchParams(
    [window.location.search.replace(/^\?/, ""), fromHash].filter(Boolean).join("&"),
  );
  return params.get("tier");
}

export function createTierOverride(cfg: TierOverrideConfig): TierOverride {
  const allowed = (): boolean => cfg.env.dev || !!cfg.env.allowInProd;

  const get = (): string | null => {
    if (!allowed()) return null;
    let stored: string | null = null;
    try {
      stored = typeof window !== "undefined" ? window.localStorage.getItem(cfg.storageKey) : null;
    } catch {
      stored = null;
    }
    const u = urlTier();
    const resolved = resolveTierOverride(
      { urlTier: u, stored, startTier: cfg.env.startTier ?? null },
      cfg.validKeys,
    );
    // Write a URL choice through to storage so it persists past the next navigation/reload.
    if (u != null) {
      try {
        if (resolved) window.localStorage.setItem(cfg.storageKey, resolved);
        else window.localStorage.removeItem(cfg.storageKey);
      } catch {
        /* ignore storage failures */
      }
    }
    return resolved;
  };

  const set = (key: string | null): void => {
    if (typeof window === "undefined") return;
    try {
      if (key && cfg.validKeys.includes(key)) window.localStorage.setItem(cfg.storageKey, key);
      else window.localStorage.removeItem(cfg.storageKey);
    } catch {
      /* ignore storage failures */
    }
  };

  return { allowed, get, set };
}
