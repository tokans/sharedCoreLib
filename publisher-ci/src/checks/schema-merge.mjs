// CONTROL: shared-DB integrity. Every published app declares its data schema with
// semantic metadata (sharedcorelib/schema). On publish the schema is checked against
// the already-registered shared schemas: identical/additive merges cleanly, anything
// incompatible is a CONFLICT that blocks the publish, and same-data-modeled-twice is
// flagged so it isn't replicated. Self-contained structural mirror of the lib engine
// (the authoritative engine is `sharedcorelib/schema`). Skips when no manifest.
import { join } from "node:path";
import { readJson, fileExists } from "../util.mjs";

const CONF = ["Public", "Internal", "Confidential", "Restricted", "Secret"];
const rank = (c) => CONF.indexOf(c);
const qn = (s) => `${s?.namespace}#${s?.name}`;
const shape = (s) => (s.fields ?? []).map((f) => `${f.name}:${f.dataType}`).sort().join(",");

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
      for (const p of manifest) {
        const existing = registry.get(qn(p));
        if (existing) {
          for (const c of conflictsVs(existing, p)) findings.push({ level: "high", message: `conflict: ${c}` });
        }
        // Duplicate candidate: same Name + field shape under a different owner.
        for (const [rq, r] of registry) {
          if (rq !== qn(p) && r.name === p.name && shape(r) === shape(p) && r.owner !== p.owner) {
            findings.push({ level: "medium", message: `${qn(p)} looks identical to ${rq} (owner ${r.owner}) — use a shared common table, don't duplicate` });
          }
        }
      }
    } else {
      findings.push({ level: "info", message: "no shared-schemas.json snapshot — validated shape only (live conflict-check runs against the registry at publish)" });
    }

    const hasHigh = findings.some((f) => f.level === "high");
    return { status: hasHigh ? "fail" : findings.some((f) => f.level === "medium") ? "warn" : "pass", findings };
  },
};
