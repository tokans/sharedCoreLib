/**
 * Content TREE — arbitrary-depth folder hierarchies (promoted from myHealth).
 *
 * A content type's folder is no longer a single flat level: it can nest to any
 * depth, e.g. `content/yoga/morning/…` (myHealth, shallow) or
 * `content/[board]/[class]/[subject]/[book]/…` (myEducation, deep). Every folder
 * is a NODE. The FILES inside a folder are that node's PROPERTIES — the filename
 * (minus its extension) is the property NAME, and the value is parsed from the
 * file by extension: `.json`→JSON, `.yaml`/`.yml`→YAML, text-like→string, and
 * anything else (images, PDFs, binaries)→a file reference (path/url, never read).
 * Subfolders are the node's CHILDREN; a folder with no subfolders is a LEAF and
 * is where the main content lives (commonly an `entries.json` property).
 *
 * Pure + filesystem-free: the APP (or a test) gathers the files — via Vite's
 * `import.meta.glob` in an app, or `fs` in a test — into {@link RawFile}s and
 * hands them to {@link buildContentTree}. Nothing here touches disk or network.
 */
import { entrySchema } from "./index.js";
import type { ContentEntry } from "./index.js";

/** A property value parsed from one file in a node's folder. */
export type PropertyValue =
  | { kind: "json"; value: unknown }
  | { kind: "yaml"; value: unknown }
  | { kind: "text"; value: string }
  | { kind: "file"; path: string; ext: string; url?: string };

/** One file to fold into the tree. `text` for parseable files; `url` for assets. */
export interface RawFile {
  /** Path relative to the content root (POSIX or Windows separators accepted). */
  path: string;
  /** Raw file text (json/yaml/text). Omit for binary/asset files. */
  text?: string;
  /** Resolved asset URL for a file-reference property (e.g. a Vite-imported image). */
  url?: string;
}

/** A node in the content tree (a folder). */
export interface ContentNode {
  /** Folder name (slug). The root node's key is `rootKey` (default ""). */
  key: string;
  /** Path segments from the tree root (root = []). */
  path: string[];
  /** Depth from the root (root = 0). */
  depth: number;
  /** True when the node has no child folders — a leaf holds the main content. */
  isLeaf: boolean;
  /** Parsed property files in this folder, keyed by filename-without-extension. */
  properties: Record<string, PropertyValue>;
  /** Child nodes (subfolders), sorted by `order` property then label/key. */
  children: ContentNode[];
  /**
   * Main content attached directly to this node (for code-constructed trees via
   * {@link buildNodeTree}). Takes precedence over an `entries` property file.
   */
  entries?: ContentEntry[];
}

const TEXT_EXTS = new Set(["md", "txt", "text", "svg", "html", "htm", "csv", "xml", "yaml-doc"]);

/** Split a filename into its base name (property name) and lowercased extension. */
function splitName(filename: string): { name: string; ext: string } {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return { name: filename, ext: "" };
  return { name: filename.slice(0, dot), ext: filename.slice(dot + 1).toLowerCase() };
}

const basename = (p: string): string => p.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? p;

/**
 * A deliberately small YAML subset for property files: nested maps (indentation),
 * scalar lists (`- item`) and one-line map list-items, with string/number/bool/null
 * scalars. For richer YAML, inject your own parser via `buildContentTree`'s options.
 */
export function parseSimpleYaml(src: string): unknown {
  const lines = src
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  let i = 0;
  const indentOf = (l: string) => l.length - l.trimStart().length;

  const scalar = (v: string): unknown => {
    if (v === "true") return true;
    if (v === "false") return false;
    if (v === "null" || v === "~" || v === "") return null;
    if (/^-?\d+$/.test(v)) return parseInt(v, 10);
    if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
    return v.replace(/^["']|["']$/g, "");
  };

  const parseBlock = (minIndent: number): unknown => {
    if (i >= lines.length || indentOf(lines[i]!) < minIndent) return null;
    const ind = indentOf(lines[i]!);
    if (lines[i]!.trimStart().startsWith("- ")) {
      const arr: unknown[] = [];
      while (i < lines.length && indentOf(lines[i]!) === ind && lines[i]!.trimStart().startsWith("- ")) {
        const item = lines[i]!.trimStart().slice(2).trim();
        i++;
        const pair = item.match(/^([\w.-]+):\s*(.*)$/);
        if (pair) arr.push({ [pair[1]!]: scalar(pair[2]!) });
        else arr.push(scalar(item));
      }
      return arr;
    }
    const obj: Record<string, unknown> = {};
    while (i < lines.length && indentOf(lines[i]!) === ind && !lines[i]!.trimStart().startsWith("- ")) {
      const m = lines[i]!.trim().match(/^([\w.-]+):\s*(.*)$/);
      if (!m) {
        i++;
        continue;
      }
      i++;
      obj[m[1]!] = m[2] === "" ? parseBlock(ind + 1) : scalar(m[2]!);
    }
    return obj;
  };

  return parseBlock(0);
}

/** Parse one file into a {@link PropertyValue}, by extension. Never throws. */
export function parseProperty(file: RawFile, yamlParse?: (s: string) => unknown): PropertyValue {
  const ext = splitName(basename(file.path)).ext;
  const fileRef = (): PropertyValue => ({ kind: "file", path: file.path, ext, url: file.url });

  if (ext === "json") {
    if (file.text == null) return fileRef();
    try {
      return { kind: "json", value: JSON.parse(file.text) };
    } catch {
      return { kind: "text", value: file.text.trim() };
    }
  }
  if (ext === "yaml" || ext === "yml") {
    if (file.text == null) return fileRef();
    return { kind: "yaml", value: (yamlParse ?? parseSimpleYaml)(file.text) };
  }
  if (ext === "" || TEXT_EXTS.has(ext)) {
    // Property files are scalars-in-a-file; trim the trailing newline editors add.
    return file.text == null ? fileRef() : { kind: "text", value: file.text.trim() };
  }
  return fileRef();
}

export interface BuildTreeOptions {
  /** Key for the synthetic root node. Default "". */
  rootKey?: string;
  /** Custom YAML parser for `.yaml`/`.yml` property files. */
  yamlParse?: (s: string) => unknown;
}

interface MutableNode extends Omit<ContentNode, "children"> {
  children: Map<string, MutableNode>;
}

/** Build a content tree from a flat list of files (filesystem-free; pure). */
export function buildContentTree(files: RawFile[], opts: BuildTreeOptions = {}): ContentNode {
  const mk = (key: string, path: string[]): MutableNode => ({
    key,
    path,
    depth: path.length,
    isLeaf: true,
    properties: {},
    children: new Map(),
  });
  const root = mk(opts.rootKey ?? "", []);

  for (const file of files) {
    const segs = file.path.replace(/\\/g, "/").split("/").filter(Boolean);
    if (segs.length === 0) continue;
    const dirs = segs.slice(0, -1);
    let cur = root;
    for (let d = 0; d < dirs.length; d++) {
      const seg = dirs[d]!;
      let child = cur.children.get(seg);
      if (!child) {
        child = mk(seg, dirs.slice(0, d + 1));
        cur.children.set(seg, child);
      }
      cur = child;
    }
    const { name } = splitName(segs[segs.length - 1]!);
    cur.properties[name] = parseProperty(file, opts.yamlParse);
  }

  const finalize = (node: MutableNode): ContentNode => {
    const children = [...node.children.values()].map(finalize);
    children.sort((a, b) => nodeOrder(a) - nodeOrder(b) || nodeLabel(a).localeCompare(nodeLabel(b)));
    return {
      key: node.key,
      path: node.path,
      depth: node.depth,
      isLeaf: children.length === 0,
      properties: node.properties,
      children,
    };
  };
  return finalize(root);
}

// ── Code-constructed trees (subtypes authored inline, not from files) ────────

/** A nested node definition for {@link buildNodeTree} — the inline-subtypes shape. */
export interface NodeDef {
  key: string;
  label?: string;
  order?: number;
  /** Leaf content attached to this node. */
  entries?: ContentEntry[];
  /** Extra property values (rarely needed; label/order are set for you). */
  properties?: Record<string, PropertyValue>;
  children?: NodeDef[];
}

/**
 * Build a {@link ContentNode} tree from an inline nested definition — the way an
 * app authors a type's SUBTYPES in code (vs. {@link buildContentTree} from files).
 * `label`/`order` become text properties so the same `nodeLabel`/`nodeOrder`
 * helpers work; children are sorted by order then label.
 */
export function buildNodeTree(def: NodeDef, opts: { path?: string[] } = {}): ContentNode {
  const path = opts.path ?? [];
  const properties: Record<string, PropertyValue> = { ...(def.properties ?? {}) };
  if (def.label != null) properties.label = { kind: "text", value: def.label };
  if (def.order != null) properties.order = { kind: "text", value: String(def.order) };
  const children = (def.children ?? []).map((c) => buildNodeTree(c, { path: [...path, c.key] }));
  children.sort((a, b) => nodeOrder(a) - nodeOrder(b) || nodeLabel(a).localeCompare(nodeLabel(b)));
  return {
    key: def.key,
    path,
    depth: path.length,
    isLeaf: children.length === 0,
    properties,
    children,
    entries: def.entries,
  };
}

// ── Read helpers ─────────────────────────────────────────────────────────────

/** A property value as a scalar string (text, or a primitive json/yaml value). */
function scalarOf(v: PropertyValue | undefined): string | undefined {
  if (!v) return undefined;
  if (v.kind === "text") return v.value;
  if (v.kind === "json" || v.kind === "yaml") {
    return typeof v.value === "string" || typeof v.value === "number" || typeof v.value === "boolean"
      ? String(v.value)
      : undefined;
  }
  return undefined;
}

/** Read a node property by name. */
export function prop(node: ContentNode, name: string): PropertyValue | undefined {
  return node.properties[name];
}

/** Read a node property as a scalar string (first match among the given names). */
export function propString(node: ContentNode, ...names: string[]): string | undefined {
  for (const n of names) {
    const s = scalarOf(node.properties[n]);
    if (s != null) return s;
  }
  return undefined;
}

/** Read a node property's structured (json/yaml) value. */
export function propData(node: ContentNode, name: string): unknown {
  const v = node.properties[name];
  return v && (v.kind === "json" || v.kind === "yaml") ? v.value : undefined;
}

/** Display label for a node: a `label`/`title`/`name` property, else a prettified key. */
export function nodeLabel(node: ContentNode): string {
  return propString(node, "label", "title", "name") ?? prettify(node.key);
}

/** Sort weight for a node: an `order` property if present, else a large default. */
export function nodeOrder(node: ContentNode): number {
  const raw = propString(node, "order");
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : 1e9;
}

function prettify(key: string): string {
  return key.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Navigate to a descendant node by path segments (undefined if absent). */
export function nodeAt(root: ContentNode, path: string[]): ContentNode | undefined {
  let cur: ContentNode | undefined = root;
  for (const seg of path) {
    cur = cur?.children.find((c) => c.key === seg);
    if (!cur) return undefined;
  }
  return cur;
}

/** All leaf nodes under `root`, in tree order. */
export function leaves(root: ContentNode): ContentNode[] {
  const out: ContentNode[] = [];
  const walk = (n: ContentNode) => (n.isLeaf ? out.push(n) : n.children.forEach(walk));
  walk(root);
  return out;
}

/**
 * The main content of a leaf: its `entries` property (a json/yaml array), coerced
 * to {@link ContentEntry}s. Invalid items are dropped (lenient). Empty if absent.
 */
export function nodeEntries(node: ContentNode): ContentEntry[] {
  if (node.entries) return node.entries;
  const raw = propData(node, "entries");
  if (!Array.isArray(raw)) return [];
  const out: ContentEntry[] = [];
  for (const item of raw) {
    const parsed = entrySchema.safeParse(item);
    if (parsed.success) out.push({ ...(parsed.data as ContentEntry), source: "baked" });
  }
  return out;
}

/**
 * Build a tree directly from a Vite `import.meta.glob` text map (path → raw text),
 * stripping `stripPrefix` (default "/content/"). Optionally merge an `assets` map
 * (path → resolved URL) for binary file-reference properties.
 */
export function buildContentTreeFromGlob(
  texts: Record<string, string>,
  opts: BuildTreeOptions & { stripPrefix?: string; assets?: Record<string, string> } = {},
): ContentNode {
  const prefix = opts.stripPrefix ?? "/content/";
  const strip = (p: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p.replace(/^\/+/, ""));
  const files: RawFile[] = [
    ...Object.entries(texts).map(([p, text]) => ({ path: strip(p), text })),
    ...Object.entries(opts.assets ?? {}).map(([p, url]) => ({ path: strip(p), url })),
  ];
  return buildContentTree(files, opts);
}
