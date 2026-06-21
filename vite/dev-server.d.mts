import type { ServerOptions } from "vite";

/**
 * Deterministic preferred dev port for a Tauri identifier (e.g. "com.myfinance.app").
 * Pure function of the identifier — identical in vite.config and sync-dev-port.mjs.
 */
export function preferredDevPort(identifier: string): number;

/**
 * Resolve the dev port for the app rooted at `cwd`: the free port chosen by
 * sync-dev-port.mjs (src-tauri/.dev.conf.json) if present, else the deterministic
 * preferred port from the app's Tauri identifier.
 */
export function resolveDevPort(cwd?: string): number;

/**
 * Vite `server` config for a suite app so it binds a unique, stable, free dev port and
 * can run alongside the other suite apps. See ./dev-server.mjs for the full design.
 */
export function devServer(opts?: { host?: string | false; cwd?: string }): ServerOptions;
