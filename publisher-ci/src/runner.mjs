// Runs the check registry against a consuming app and renders a report.
// Exit code is driven by the configured `failOn` severity threshold.
export const LEVELS = ["info", "low", "medium", "high", "critical"];
export const levelRank = (l) => LEVELS.indexOf(l);

const ICON = { pass: "✓", warn: "!", fail: "✗", skip: "–" };
const LEVEL_TAG = {
  critical: "CRIT", high: "HIGH", medium: "MED", low: "LOW", info: "INFO",
};

/**
 * A check is `{ id, title, severity, run(ctx) }`. `run` returns
 * `{ status, findings: [{ level, message, file?, line?, hint? }] }`.
 */
export async function runAll(ctx, checks) {
  const results = [];
  for (const check of checks) {
    try {
      const r = await check.run(ctx);
      results.push({ id: check.id, title: check.title, severity: check.severity, ...r });
    } catch (e) {
      results.push({
        id: check.id, title: check.title, severity: check.severity, status: "fail",
        findings: [{ level: "high", message: `check crashed: ${e.message}` }],
      });
    }
  }
  return results;
}

export function summarize(results, failOn) {
  const threshold = levelRank(failOn);
  let worst = -1;
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const r of results) {
    for (const f of r.findings ?? []) {
      counts[f.level] = (counts[f.level] ?? 0) + 1;
      worst = Math.max(worst, levelRank(f.level));
    }
  }
  const failed = worst >= threshold;
  return { counts, worst, failed };
}

export function renderText(results, summary, failOn) {
  const lines = [];
  lines.push("");
  lines.push("  sharedcorelib · publisher security checks");
  lines.push("  " + "─".repeat(44));
  for (const r of results) {
    const findings = r.findings ?? [];
    lines.push(`  ${ICON[r.status] ?? "?"} ${r.id}  ${dim(r.title)}`);
    for (const f of findings) {
      const loc = f.file ? `  ${f.file}${f.line ? ":" + f.line : ""}` : "";
      lines.push(`      [${LEVEL_TAG[f.level]}] ${f.message}${loc}`);
      if (f.hint) lines.push(`             ↳ ${f.hint}`);
    }
  }
  lines.push("  " + "─".repeat(44));
  const c = summary.counts;
  lines.push(
    `  critical:${c.critical}  high:${c.high}  medium:${c.medium}  low:${c.low}  info:${c.info}`,
  );
  lines.push(
    summary.failed
      ? `  RESULT: FAIL (findings at or above "${failOn}")`
      : `  RESULT: PASS (threshold "${failOn}")`,
  );
  lines.push("");
  return lines.join("\n");
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
