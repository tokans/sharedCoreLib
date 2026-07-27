/**
 * Reading a `DocModel`.
 *
 * These exist so a domain mapper is a short, declarative "find the table
 * whose headers look like X, map its records" rather than a hand-rolled tree
 * walk repeated in every mapper. A mapper that finds itself reaching past
 * these helpers into `ref` and back to the interim geometry is a signal the
 * builder is missing a capability — that is the seam to fix, not to route
 * around.
 */
import type { DocModel, DocNode, DocRecord, DocSection, DocTable, DocProperties, DocText } from "./types";

/** Depth-first walk over every node, parents before children. */
export function* walk(root: DocModel | DocNode[]): Generator<DocNode> {
  const nodes = Array.isArray(root) ? root : root.children;
  for (const node of nodes) {
    yield node;
    if (node.kind === "section") yield* walk(node.children);
    if (node.kind === "table") {
      for (const record of node.records) {
        if (record.children) yield* walk(record.children);
      }
    }
    if (node.kind === "properties") {
      for (const entry of node.entries) {
        if (entry.children) yield* walk(entry.children);
      }
    }
  }
}

/** Every node paired with the titles of the sections enclosing it — the
 *  breadcrumb a mapper needs to tell "Part B1's amount column" from "Part
 *  B7's", which is exactly the distinction a flat scan gets wrong. */
export function* walkWithPath(
  root: DocModel | DocNode[],
  path: string[] = [],
): Generator<{ node: DocNode; path: string[] }> {
  const nodes = Array.isArray(root) ? root : root.children;
  for (const node of nodes) {
    yield { node, path };
    if (node.kind === "section") yield* walkWithPath(node.children, [...path, node.title]);
    if (node.kind === "table") {
      for (const record of node.records) {
        if (record.children) yield* walkWithPath(record.children, path);
      }
    }
    if (node.kind === "properties") {
      for (const entry of node.entries) {
        if (entry.children) yield* walkWithPath(entry.children, path);
      }
    }
  }
}

export function tables(root: DocModel | DocNode[]): DocTable[] {
  return [...walk(root)].filter((n): n is DocTable => n.kind === "table");
}

/**
 * Tables the DOCUMENT lays out — descending through sections, but NOT into
 * the sub-tables nested under a record.
 *
 * The distinction matters whenever a mapper turns each record into a domain
 * entity. `tables()` returns a deductor's per-transaction breakup alongside
 * the deductor table itself, so the same rows get mapped twice: once as
 * transactions (correctly, via `record.children`) and once as phantom
 * top-level entities with an empty name. Use this when iterating "the tables
 * of this document", and reach into `record.children` for what hangs off a row.
 */
export function sectionTables(root: DocModel | DocNode[]): DocTable[] {
  const nodes = Array.isArray(root) ? root : root.children;
  const out: DocTable[] = [];
  for (const node of nodes) {
    if (node.kind === "table") out.push(node);
    else if (node.kind === "section") out.push(...sectionTables(node.children));
  }
  return out;
}

export function sections(root: DocModel | DocNode[]): DocSection[] {
  return [...walk(root)].filter((n): n is DocSection => n.kind === "section");
}

export function propertyBlocks(root: DocModel | DocNode[]): DocProperties[] {
  return [...walk(root)].filter((n): n is DocProperties => n.kind === "properties");
}

export function texts(root: DocModel | DocNode[]): DocText[] {
  return [...walk(root)].filter((n): n is DocText => n.kind === "text");
}

/**
 * Every piece of text in the model, one string per source row, in reading
 * order — section titles, table headers, each record's printed cells, each
 * key/value pair, each free-text node.
 *
 * For the scans that are genuinely textual rather than structural: pulling a
 * PAN or an assessment year out of a document's header block, where the value
 * may sit anywhere and the label wording varies. Those want to read the
 * document as prose, and forcing them through the structure would only make
 * them brittle to how a particular export happened to lay its header out.
 */
export function textLines(root: DocModel | DocNode[]): string[] {
  return rowCells(root).map((cells) => cells.join(" "));
}

/**
 * Every source row as its ordered cell values, rather than one joined string.
 *
 * The distinction matters for the "label in one column, its value a row below
 * in the SAME column" layout that document header blocks use — a Form 16
 * prints the employer's details in the left column and the employee's in the
 * right, so a joined line reads "Employer-label Employee-label" and then
 * "EmployerName EmployeeName", and no amount of string matching separates
 * them. Reading the first cell of each row does, without going back to
 * coordinates: the columns are already columns by the time they get here.
 *
 * A record's `unmatched` is emitted as its OWN entry rather than appended to
 * the record's cells. It has to be: that text was PARKED on this record from a
 * different physical row (a set-aside sub-table header, a stray fragment), so
 * appending it merges two source rows into one line and breaks the very
 * contract this function states. A Form 16 quarter row read as
 * `Q<n> <receipt> <amount> <amount> <amount>` — a fixed, anchored shape —
 * silently stopped matching once two extra parked tokens rode along on the end
 * of it, taking the quarterly TDS table, the challan table and all of Part B
 * with it. The parked text still appears, so nothing a prose scan needs
 * becomes invisible; it just no longer contaminates its host row.
 */
export function rowCells(root: DocModel | DocNode[]): string[][] {
  const out: string[][] = [];
  for (const node of walk(root)) {
    switch (node.kind) {
      case "section":
        out.push([node.title]);
        break;
      case "text":
        out.push([node.text]);
        break;
      case "properties":
        for (const e of node.entries) {
          out.push([e.key, e.value, ...(e.extras ?? [])].filter((v): v is string => Boolean(v)));
        }
        break;
      case "table":
        out.push(node.headers);
        for (const r of node.records) {
          out.push(r.parts);
          // One entry per parked row, not one entry for all of them: each was
          // set aside from a DIFFERENT source row, and a long interruption
          // (a signature block, a page of notes) parks dozens onto whichever
          // record was last. Emitting them as a single line concatenates the
          // lot — 26 rows became one 2,300-character string, which is how
          // Form 16's `PART B` page heading stopped being a line of its own
          // and the whole annexure went unread.
          for (const u of r.unmatched ?? []) out.push([u]);
        }
        break;
    }
  }
  return out;
}

/** The first section whose title matches, searched depth-first. */
export function findSection(root: DocModel | DocNode[], match: RegExp | ((title: string) => boolean)): DocSection | null {
  const test = typeof match === "function" ? match : (t: string) => match.test(t);
  for (const node of walk(root)) {
    if (node.kind === "section" && test(node.title)) return node;
  }
  return null;
}

/**
 * Tables whose headers satisfy `match`. The predicate receives the header
 * list so a mapper can score it however it likes (all of these present, at
 * least two of these, a specific one absent) rather than the library
 * imposing one matching rule.
 */
export function findTables(root: DocModel | DocNode[], match: (headers: string[]) => boolean): DocTable[] {
  return tables(root).filter((t) => match(t.headers));
}

/** Case- and whitespace-insensitive lookup of a record cell, so a mapper
 *  doesn't have to reproduce a header's exact printed casing/spacing. */
export function cell(record: DocRecord, header: string): string | null {
  const want = header.trim().toLowerCase().replace(/\s+/g, " ");
  for (const [key, value] of Object.entries(record.cells)) {
    if (key.trim().toLowerCase().replace(/\s+/g, " ") === want) return value;
  }
  return null;
}

/** The first cell whose header matches any of `patterns` — the usual way a
 *  mapper binds a semantic field ("the tax-deducted column") to whatever the
 *  document happened to call it. */
export function cellByPattern(record: DocRecord, patterns: RegExp[]): string | null {
  for (const [key, value] of Object.entries(record.cells)) {
    if (patterns.some((p) => p.test(key))) return value;
  }
  return null;
}

/** Collapses every key/value block reachable from `root` into one lookup —
 *  convenient for a document's identity fields (PAN, assessment year, name),
 *  which real documents scatter across several small blocks. Later blocks do
 *  not overwrite earlier ones, so the first occurrence wins. */
export function propertyMap(root: DocModel | DocNode[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of propertyBlocks(root)) {
    for (const entry of block.entries) {
      const key = entry.key.trim().toLowerCase().replace(/\s+/g, " ");
      if (key && entry.value != null && !out.has(key)) out.set(key, entry.value);
    }
  }
  return out;
}

/** Looks up a property by pattern across every key/value block. */
export function property(root: DocModel | DocNode[], pattern: RegExp): string | null {
  for (const block of propertyBlocks(root)) {
    for (const entry of block.entries) {
      if (pattern.test(entry.key) && entry.value != null) return entry.value;
    }
  }
  return null;
}
