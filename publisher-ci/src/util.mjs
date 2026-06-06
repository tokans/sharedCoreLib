// Zero-dependency filesystem + scanning helpers for the security checks.
// Node built-ins only, so app publishers can run the toolkit with no install graph.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const DEFAULT_IGNORE = new Set([
  "node_modules", "dist", "build", "target", ".git", ".next", "coverage", "out",
]);

const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".json", ".toml", ".env",
]);

/** Recursively list text-ish files under `roots`, skipping ignored dirs. */
export function walk(appDir, { include = ["."], ignore = [], exts } = {}) {
  const skip = new Set([...DEFAULT_IGNORE, ...ignore]);
  const wantExt = exts ? new Set(exts) : TEXT_EXTS;
  const out = [];
  const seen = new Set();

  const isTestFile = (name) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(name);

  const visit = (abs) => {
    let st;
    try { st = statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) {
        if (skip.has(name)) continue;
        visit(join(abs, name));
      }
    } else if (st.isFile()) {
      // Test/spec files aren't shipped (excluded from the build) — don't scan them.
      if (isTestFile(abs)) return;
      if (wantExt.has(extname(abs)) && !seen.has(abs)) {
        seen.add(abs);
        out.push(abs);
      }
    }
  };

  for (const rel of include) visit(join(appDir, rel));
  return out;
}

export function read(path) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

export function readJson(path) {
  const txt = read(path);
  if (txt == null) return null;
  // Strip a leading UTF-8 BOM — common on Windows-authored files — before parsing.
  try { return JSON.parse(txt.replace(/^﻿/, "")); } catch { return { __parseError: true }; }
}

export function fileExists(path) {
  return existsSync(path);
}

/** Yield { line, text } for every line matching `re` (re must be global or it's wrapped). */
export function* matchLines(content, re) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) yield { line: i + 1, text: lines[i].trim() };
  }
}

/**
 * Whether a line opts out of a check via `publisher-ci-ignore[: <check-id>]`.
 * A bare marker suppresses any check; `publisher-ci-ignore: kdf-floor` suppresses
 * only that one. Use sparingly, for deliberate exceptions (e.g. a legacy read-only path).
 */
export function lineIgnored(text, checkId) {
  const m = text.match(/publisher-ci-ignore(?::\s*([\w-]+))?/);
  if (!m) return false;
  return !m[1] || m[1] === checkId;
}

/** Make a path printable relative to the app dir. */
export function rel(appDir, abs) {
  return abs.startsWith(appDir) ? abs.slice(appDir.length).replace(/^[\\/]/, "") : abs;
}

/** Parse "1.4.0" → [1,4,0]; tolerant of a leading v and missing parts. */
export function parseSemver(v) {
  const m = String(v ?? "").trim().replace(/^v/i, "").split("-")[0].split(".");
  return [Number(m[0]) || 0, Number(m[1]) || 0, Number(m[2]) || 0];
}
