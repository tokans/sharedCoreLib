// CONTROL: shared-DB integrity. Every published app declares its data schema with
// semantic metadata (sharedcorelib/schema). On publish the schema is checked against
// the already-registered shared schemas: identical/additive merges cleanly, anything
// incompatible is a CONFLICT that blocks the publish, and same-data-modeled-twice
// (a cross-owner look-alike or high column-name similarity) BLOCKS by default —
// unless the descriptor `adopts` the existing table or carries a reviewed
// `duplicateOverride` (config `schema.duplicates: "warn"` downgrades to advisory).
// Self-contained structural mirror of the lib engine (the authoritative engine is
// `sharedcorelib/schema`). Skips when no manifest.
import { join } from "node:path";
import { readJson, fileExists } from "../util.mjs";

const CONF = ["Public", "Internal", "Confidential", "Restricted", "Secret"];
const rank = (c) => CONF.indexOf(c);
const qn = (s) => `${s?.namespace}#${s?.name}`;
const shape = (s) => (s.fields ?? []).map((f) => `${f.name}:${f.dataType}`).sort().join(",");

// ── Duplicate-candidate heuristic (mirrors sharedcorelib/schema) ─────────────
// Standard audit/sync/identity columns carry no duplication signal.
const NON_SIGNIFICANT_COLUMNS = new Set([
  "id", "uuid", "guid",
  "createdat", "createdon", "createdby", "updatedat", "updatedon", "updatedby",
  "modifiedat", "modifiedon", "modifiedby", "deletedat", "deleted", "tombstone",
  "version", "rev", "revision", "dirty",
  "syncstate", "syncstatus", "lastsyncedat", "syncedat", "deviceid",
]);
const SIMILARITY_THRESHOLD = 0.7;
const normCol = (n) => String(n ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const sigCols = (s) => {
  const out = new Set();
  for (const f of s.fields ?? []) {
    const n = normCol(f.name);
    if (n && !NON_SIGNIFICANT_COLUMNS.has(n)) out.add(n);
  }
  return out;
};
// Cross-owner duplicate: exact Name+shape look-alike, OR Jaccard ≥ threshold over ≥ 2
// significant columns (audit/sync columns ignored).
function isDuplicateCandidate(p, r) {
  if (r.owner === p.owner) return false;
  if (r.name === p.name && shape(r) === shape(p)) return true;
  const a = sigCols(p), b = sigCols(r);
  if (!a.size || !b.size) return false;
  let inter = 0;
  for (const c of a) if (b.has(c)) inter++;
  if (inter < 2) return false;
  return inter / (a.size + b.size - inter) >= SIMILARITY_THRESHOLD;
}

function validateDescriptor(s, findings) {
  const q = qn(s);
  for (const k of ["namespace", "name", "schemaType", "confidentiality", "owner"]) {
    if (!s[k]) findings.push({ level: "high", message: `${q}: missing "${k}"` });
  }
  if (!Array.isArray(s.fields) || s.fields.length === 0) {
    findings.push({ level: "high", message: `${q}: needs at least one field` }); return;
  }
  if (s.schemaType === "Table" && !s.fields.some((f) => f.keyField)) {
    findings.push({ level: "high", message: `${q}: a Table needs at least one keyField` });
  }
  for (const f of s.fields) {
    if (f.personalData) {
      if ((f.confidentiality ?? s.confidentiality) === "Public") {
        findings.push({ level: "high", message: `${q}.${f.name}: personal data must not be Public (DPDP)` });
      }
      if (!f.purpose) findings.push({ level: "high", message: `${q}.${f.name}: personal data needs a purpose (DPDP)` });
    }
  }
  if (s.adopts !== undefined && !/^[^#\s]+#[^#\s]+$/.test(String(s.adopts))) {
    findings.push({ level: "high", message: `${q}: "adopts" must be a qualified name "namespace#Name"` });
  }
  if (s.adopts === q) {
    findings.push({ level: "high", message: `${q}: a schema cannot adopt itself` });
  }
}

function conflictsVs(existing, proposed) {
  const out = [];
  const q = qn(existing);
  if (existing.schemaType !== proposed.schemaType) out.push(`${q}: schema-kind ${existing.schemaType} vs ${proposed.schemaType}`);
  if (rank(proposed.confidentiality) < rank(existing.confidentiality)) out.push(`${q}: confidentiality downgrade ${existing.confidentiality}→${proposed.confidentiality}`);
  const ex = new Map((existing.fields ?? []).map((f) => [f.name, f]));
  for (const pf of proposed.fields ?? []) {
    const ef = ex.get(pf.name);
    if (!ef) continue; // additive — fine
    if (ef.dataType !== pf.dataType) out.push(`${q}.${pf.name}: type ${ef.dataType} vs ${pf.dataType}`);
    if (!!ef.keyField !== !!pf.keyField) out.push(`${q}.${pf.name}: keyField changed`);
    if (!!ef.personalData !== !!pf.personalData) out.push(`${q}.${pf.name}: personalData changed`);
  }
  return out;
}

export default {
  id: "schema-merge",
  title: "Data schema validates + merges with the shared registry",
  severity: "high",
  run({ appDir, config }) {
    const path = join(appDir, config.schema?.manifest ?? "schema.manifest.json");
    if (!fileExists(path)) {
      return { status: "skip", findings: [{ level: "info", message: "no schema.manifest.json — skipped (declare your data schema to register it)" }] };
    }
    const manifest = readJson(path);
    if (!manifest || manifest.__parseError || !Array.isArray(manifest)) {
      return { status: "fail", findings: [{ level: "high", message: `${config.schema?.manifest} must be a JSON array of schema descriptors` }] };
    }

    const findings = [];
    for (const s of manifest) validateDescriptor(s, findings);

    // Conflict-check against a registry snapshot, if one is committed.
    const regPath = join(appDir, config.schema?.registry ?? "shared-schemas.json");
    if (fileExists(regPath)) {
      const regArr = readJson(regPath);
      const registry = new Map((Array.isArray(regArr) ? regArr : []).map((s) => [qn(s), s]));
      // Duplicates are a HARD BLOCK by default; set schema.duplicates: "warn" to downgrade.
      const dupMode = config.schema?.duplicates ?? "block";
      for (const p of manifest) {
        const existing = registry.get(qn(p));
        if (existing) {
          for (const c of conflictsVs(existing, p)) findings.push({ level: "high", message: `conflict: ${c}` });
        }
        // Duplicate candidate: a cross-owner look-alike (same Name + shape, or high
        // column-name similarity). Exempt when the descriptor ADOPTS the existing table
        // or carries a reviewed duplicateOverride.
        for (const [rq, r] of registry) {
          if (rq === qn(p) || !isDuplicateCandidate(p, r)) continue;
          if (p.adopts === rq) {
            findings.push({ level: "info", message: `${qn(p)} adopts ${rq} — uses the existing table, no duplicate created` });
            continue;
          }
          if (typeof p.duplicateOverride === "string" && p.duplicateOverride.trim()) {
            findings.push({ level: "medium", message: `${qn(p)} duplicates ${rq} (owner ${r.owner}) — kept by reviewed override: ${p.duplicateOverride}` });
            continue;
          }
          findings.push({
            level: dupMode === "block" ? "high" : "medium",
            message: `duplicate: ${qn(p)} looks like ${rq} (owner ${r.owner}) — adopt it ("adopts": "${rq}"), use a shared common table, or carry a reviewed "duplicateOverride"`,
          });
        }
      }
    } else {
      findings.push({ level: "info", message: "no shared-schemas.json snapshot — validated shape only (live conflict-check runs against the registry at publish)" });
    }

    const hasHigh = findings.some((f) => f.level === "high");
    return { status: hasHigh ? "fail" : findings.some((f) => f.level === "medium") ? "warn" : "pass", findings };
  },
};
