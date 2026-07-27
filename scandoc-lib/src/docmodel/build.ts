/**
 * Blocks to tree: resolves the source document's indentation into an actual
 * hierarchy and emits the `DocModel`.
 *
 * This is the last step that reads geometry. Indent is consulted here to
 * decide whether a heading is a child, a sibling, or an uncle of the heading
 * above it, and is then thrown away — a node carries an integer `level`, not
 * an x position.
 */
import { analyze } from "./classify";
import { groupBlocks, type Block, type RawRecord } from "./blocks";
import { stripFurniture } from "./boilerplate";
import type { PositionalDoc } from "./positional";
import type {
  DocModel,
  DocModelOptions,
  DocNode,
  DocRecord,
  DocSection,
  DocSourceKind,
  DocTable,
} from "./types";

const DEFAULT_INDENT_TOLERANCE = 8;

function toRecord(raw: RawRecord, opts: DocModelOptions): DocRecord {
  const cells: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw.cells)) cells[key] = value === "" ? null : value;
  const record: DocRecord = { cells, parts: raw.parts };
  if (raw.unmatched.length) record.unmatched = raw.unmatched;
  if (raw.children.length) record.children = raw.children.map((b) => toNode(b, opts));
  return record;
}

function toNode(block: Block, opts: DocModelOptions): DocNode {
  const ref = { page: block.page, rows: block.rows };
  switch (block.kind) {
    case "table": {
      const table: DocTable = {
        kind: "table",
        headers: block.columns.map((c) => c.text),
        records: block.records.map((r) => toRecord(r, opts)),
        ref,
      };
      return table;
    }
    case "properties":
      return {
        kind: "properties",
        entries: block.entries.map((e) => ({
          key: e.key,
          value: e.value === "" ? null : e.value,
          ...(e.extras.length ? { extras: e.extras } : {}),
        })),
        ref,
      };
    case "heading":
      // Only reached for a heading that opens no section (nothing followed
      // it) — it still carries information, so it survives as text rather
      // than being dropped for having no children.
      return { kind: "text", text: block.text, ref };
    case "text":
      return { kind: "text", text: block.text, ref };
  }
}

interface Frame {
  indent: number;
  section: DocSection;
}

/**
 * Builds the node tree. Headings open sections; every other block attaches to
 * the innermost section still open at its own indent.
 *
 * The three-way heading comparison (child / sibling / ancestor) is the same
 * rule a computation sheet's own layout encodes: further right is nested,
 * roughly level is a sibling, further left closes back out. Tolerance is
 * necessarily approximate because real templates jitter — a misjudged level
 * still keeps the section and its contents intact and visible, which is the
 * property that matters.
 */
function buildTree(blocks: Block[], opts: DocModelOptions): DocNode[] {
  const tolerance = opts.indentTolerance ?? DEFAULT_INDENT_TOLERANCE;
  const root: DocNode[] = [];
  const stack: Frame[] = [];

  const extendRefs = (end: number): void => {
    for (const frame of stack) frame.section.ref.rows[1] = Math.max(frame.section.ref.rows[1], end);
  };

  const contentCloses = opts.sectionNesting === "indent";

  for (const block of blocks) {
    if (block.kind === "heading" || contentCloses) {
      while (stack.length && block.indent <= stack[stack.length - 1].indent - tolerance) stack.pop();
    }

    if (block.kind === "heading") {
      // Roughly the same indent as the section currently open: a sibling of
      // it, not a child — close that one before opening this.
      if (stack.length && Math.abs(block.indent - stack[stack.length - 1].indent) <= tolerance) stack.pop();

      const section: DocSection = {
        kind: "section",
        title: block.text,
        level: stack.length,
        children: [],
        ref: { page: block.page, rows: [block.rows[0], block.rows[1]] },
      };
      (stack.length ? stack[stack.length - 1].section.children : root).push(section);
      extendRefs(block.rows[1]);
      stack.push({ indent: block.indent, section });
      continue;
    }

    (stack.length ? stack[stack.length - 1].section.children : root).push(toNode(block, opts));
    extendRefs(block.rows[1]);
  }

  return root;
}

/** Sections that never received content are headings that opened nothing —
 *  demoted back to text so the model doesn't imply structure the document
 *  didn't have, while still keeping the words. */
function demoteEmptySections(nodes: DocNode[]): DocNode[] {
  return nodes.map((node) => {
    if (node.kind !== "section") return node;
    const children = demoteEmptySections(node.children);
    if (children.length === 0) return { kind: "text", text: node.title, ref: node.ref } as DocNode;
    return { ...node, children };
  });
}

export interface BuildInput {
  doc: PositionalDoc;
  filename: string;
  kind: DocSourceKind;
}

/**
 * The whole pipeline: strip page furniture, measure every row, group rows
 * into blocks, resolve indentation into a tree.
 *
 * The interim `PositionalDoc` is the caller's to keep — dump it for
 * diagnostics, but map domain types off the returned `DocModel` only.
 */
export function buildDocModel(input: BuildInput, opts: DocModelOptions): DocModel {
  const warnings: string[] = [];
  const { doc, removed } = stripFurniture(input.doc, opts);
  if (removed > 0) {
    warnings.push(`${removed} repeated page-furniture row(s) were removed before structuring.`);
  }

  const features = analyze(doc.rows, opts);
  const blocks = groupBlocks(features, opts);
  const children = demoteEmptySections(buildTree(blocks, opts));

  if (children.length === 0 && doc.rows.length > 0) {
    warnings.push("No structure was recognized in this document — check the interim extraction.");
  }

  return {
    source: { filename: input.filename, kind: input.kind, pages: doc.pages },
    children,
    warnings,
  };
}
