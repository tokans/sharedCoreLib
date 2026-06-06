/**
 * UI foundation — app-agnostic.
 *
 * Currently exposes the `cn` class-name merge helper (clsx + tailwind-merge) that
 * every shadcn-style primitive and most components build on. It is safe to share
 * with NO Tailwind `content`-config change, because `cn` only merges class strings
 * that originate in the consuming app's own source (which Tailwind already scans).
 *
 * NOTE: the heavier UI kit — the shadcn/ui primitives, `AppShell`, and
 * `FiniteSetInput` — is intentionally NOT yet extracted. Moving those into this
 * package requires the consuming app to add this package's source to its Tailwind
 * `content` globs (otherwise the primitives' utility classes get purged), and
 * `AppShell`/`FiniteSetInput` carry app-specific concerns (nav config, the
 * master-data hook) that must be injected first. See CONTRACT.md → "UI kit".
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class names, de-duplicating conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type { ClassValue };
