// Copy non-TS assets (baked master JSON) into dist next to their compiled
// modules. tsc type-checks JSON imports but does not emit the .json files, so the
// dist `import "./data/*.json"` would otherwise dangle. Run after `tsc` in build.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "src/masters/data");
const dest = resolve(root, "dist/masters/data");

if (existsSync(src)) {
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`copied masters data → ${dest}`);
}
