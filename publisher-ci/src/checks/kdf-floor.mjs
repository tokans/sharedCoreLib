// CONTROL: §5 — crypto hygiene. Flags weak KDF parameters and non-CSPRNG randomness in
// any source the app vendors or re-implements. Heuristic but high-signal.
import { walk, read, matchLines, rel, lineIgnored } from "../util.mjs";

const SECRET_WORDS = /(key|token|secret|iv|nonce|salt|password|seed)/i;

export default {
  id: "kdf-floor",
  title: "Strong KDF params + CSPRNG for secrets",
  severity: "high",
  run({ appDir, config }) {
    const files = walk(appDir, { include: config.source.include, ignore: config.source.ignore });
    const findings = [];
    const floor = config.kdf?.minPbkdf2Iterations ?? 600000;

    for (const file of files) {
      const content = read(file);
      if (!content) continue;
      const where = rel(appDir, file);

      // PBKDF2 iteration counts below the floor — both inline (`iterations: 150000`)
      // and via a named constant (`const PBKDF2_ITERS = 150_000`).
      const iterRe = /(?:iterations\s*[:=]|\b\w*ITER\w*\b\s*=)\s*([0-9_]+)/gi;
      for (const { line, text } of matchLines(content, iterRe)) {
        if (lineIgnored(text, "kdf-floor")) continue;
        iterRe.lastIndex = 0;
        const num = Number((iterRe.exec(text)?.[1] ?? "").replace(/_/g, ""));
        if (num && num < floor) {
          findings.push({ level: "high", message: `PBKDF2 iteration count ${num} below floor ${floor}`, file: where, line, hint: "raise to ≥600k or switch to Argon2id" });
        }
      }

      // Math.random() used on a line that also mentions a secret-ish word.
      for (const { line, text } of matchLines(content, /Math\.random\s*\(/)) {
        if (lineIgnored(text, "kdf-floor")) continue;
        if (SECRET_WORDS.test(text)) {
          findings.push({ level: "high", message: "Math.random() used for a secret/identifier", file: where, line, hint: "use crypto.getRandomValues / crypto.randomUUID" });
        }
      }

      // AES-GCM seal without an obvious version header (informational heuristic).
      if (config.kdf?.requireFormatHeader && /AES-GCM/i.test(content) && !/(VERSION|FORMAT_VERSION|formatVersion|\bv1\b)/i.test(content)) {
        findings.push({ level: "low", message: "AES-GCM sealing without a visible format/version header", file: where, hint: "prefix a version byte so the format can evolve" });
      }
    }

    return { status: findings.some((f) => f.level === "high") ? "fail" : findings.length ? "warn" : "pass", findings };
  },
};
