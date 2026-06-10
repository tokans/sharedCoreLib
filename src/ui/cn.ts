/**
 * `cn` — the class-name merge helper (clsx + tailwind-merge) every shadcn-style primitive
 * builds on. Kept in its own module so the shared primitives/shell can import it without a
 * cycle through `index.ts` (which re-exports it).
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class names, de-duplicating conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type { ClassValue };
