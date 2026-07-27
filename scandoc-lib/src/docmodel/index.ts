/**
 * @scandoc/core/docmodel — turning an extracted document into a positionless,
 * nested, document-shaped model.
 *
 * The contract, in one line: **geometry in, structure out**. Callers hand in
 * a `PositionalDoc` (glyph-derived rows and cells from a PDF, or a synthetic
 * grid adapted from a spreadsheet or delimited text) and receive a `DocModel`
 * of sections, tables keyed by their own headers, key/value regions, nested
 * sub-tables, and text — with no x/y anywhere in it.
 *
 * Domain knowledge lives entirely on the far side of that line. This module
 * has no vocabulary, no field names, no document types; the consuming app
 * supplies number/date recognition and maps the model onto its own types.
 */
export type {
  DocModel,
  DocModelOptions,
  DocNode,
  DocRecord,
  DocRef,
  DocSection,
  DocSourceKind,
  DocTable,
  DocText,
  DocProperties,
  DocProperty,
  DocValue,
} from "./types";

export {
  fromNativeRows,
  indentOf,
  isBlank,
  mapCells,
  populated,
  rowSignature,
  rowText,
  type NativeTableRow,
  type PositionalCell,
  type PositionalDoc,
  type PositionalRow,
} from "./positional";

export {
  CELL_WIDTH,
  COLUMN_SLOT,
  DEFAULT_DELIMITERS,
  GRID_INDENT_TOLERANCE,
  detectDelimiter,
  fromDelimitedText,
  fromExtraction,
  fromGrids,
  indentToleranceFor,
  type DelimitedOptions,
  type Extraction,
  type Grid,
} from "./adapters";

export { buildDocModel, type BuildInput } from "./build";

export { findRepeatedRows, stripFurniture, stripPatterns } from "./boilerplate";

export {
  MAX_COLUMN_DISTANCE,
  alignRow,
  alignmentScore,
  nearestColumn,
  type Column,
} from "./align";

export {
  cell,
  cellByPattern,
  findSection,
  findTables,
  property,
  propertyBlocks,
  propertyMap,
  rowCells,
  sectionTables,
  sections,
  tables,
  textLines,
  texts,
  walk,
  walkWithPath,
} from "./query";
