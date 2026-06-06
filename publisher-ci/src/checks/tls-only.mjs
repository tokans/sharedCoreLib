// CONTROL: §7 — no plaintext network. Flags http:// URLs in source/config (localhost
// excepted) so the feed, download links, and any fetch stay HTTPS. Signatures are the
// integrity anchor; TLS is defense-in-depth against metadata leakage + downgrade.
import { walk, read, matchLines, rel, lineIgnored } from "../util.mjs";

const PLAINTEXT = /http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/i;

export default {
  id: "tls-only",
  title: "HTTPS-only network endpoints",
  severity: "high",
  run({ appDir, config }) {
    if (!config.feed?.requireHttps) return { status: "skip", findings: [{ level: "info", message: "feed.requireHttps disabled" }] };
    const files = walk(appDir, { include: config.source.include, ignore: config.source.ignore });
    const findings = [];
    for (const file of files) {
      const content = read(file);
      if (!content) continue;
      const where = rel(appDir, file);
      for (const { line, text } of matchLines(content, PLAINTEXT)) {
        if (lineIgnored(text, "tls-only")) continue;
        findings.push({ level: "high", message: `plaintext http:// endpoint: ${text.slice(0, 80)}`, file: where, line, hint: "use https:// (and pin TLS to the feed domain)" });
      }
    }
    return { status: findings.length ? "fail" : "pass", findings };
  },
};
