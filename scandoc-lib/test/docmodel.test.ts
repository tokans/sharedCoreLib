/**
 * These fixtures reproduce the LAYOUTS the myFinance parsers were hardened
 * against — Form 26AS's repeated-header/nested-subtable PDF, its delimited
 * text export, a bank statement with a wrapped narration, a computation
 * sheet. They are the reason the builder exists: every one of them
 * previously needed a bespoke structural hack in its own domain parser.
 *
 * Every value is invented. Only geometry and row shape matter to these
 * tests, so no real name, PAN, TAN, account number or institution appears
 * here — and none should ever be added. Use the placeholders below.
 */
import { describe, expect, it } from "vitest";
import {
  buildDocModel,
  detectDelimiter,
  fromDelimitedText,
  fromGrids,
  GRID_INDENT_TOLERANCE,
  tables,
  texts,
  findSection,
  property,
  type DocModelOptions,
  type DocTable,
  type PositionalCell,
  type PositionalDoc,
  type PositionalRow,
} from "../src/docmodel";

// ---------------------------------------------------------------------------
// The number/date recognizers a consuming app injects. Copied in shape from
// myFinance's own parseAmount/parseStatementDate so the tests exercise the
// same classification behaviour production will see.
// ---------------------------------------------------------------------------

const parseNumber = (raw: string): number | null => {
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/^(₹|rs\.?|inr)\s*/i, "").replace(/,/g, "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const value = parseFloat(s);
  return Number.isNaN(value) ? null : negative ? -Math.abs(value) : value;
};

const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
const parseDate = (raw: string): string | null => {
  const s = raw.trim();
  if (/^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s-]+(\d{4})$/);
  if (m && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) return s;
  return null;
};

const PDF_OPTS: DocModelOptions = { parseNumber, parseDate };
const GRID_OPTS: DocModelOptions = { parseNumber, parseDate, indentTolerance: GRID_INDENT_TOLERANCE };

// ---------------------------------------------------------------------------
// Fixture helpers: a PDF row is a list of [text, x] pairs; widths approximate
// rendered text so span-containment matching behaves as it does on real input.
// ---------------------------------------------------------------------------

type CellSpec = [string, number] | [string, number, number];

function cells(specs: CellSpec[]): PositionalCell[] {
  return specs.map(([text, x, width]) => ({ text, x, width: width ?? Math.max(text.length * 5, 12) }));
}

function pdfDoc(rows: CellSpec[][], pages = 1): PositionalDoc {
  const out: PositionalRow[] = rows.map((spec, i) => ({ page: 0, row: i, cells: cells(spec) }));
  return { rows: out, pages };
}

function build(doc: PositionalDoc, opts: DocModelOptions = PDF_OPTS) {
  return buildDocModel({ doc, filename: "fixture", kind: "pdf" }, opts);
}

// ---------------------------------------------------------------------------

describe("tables with headers", () => {
  it("keys records by header text and snaps cells by position, not index", () => {
    const model = build(
      pdfDoc([
        [["Date", 30], ["Narration", 90], ["Withdrawal", 300], ["Deposit", 380], ["Balance", 460]],
        [["01/04/2026", 30], ["SALARY CREDIT", 90], ["50000.00", 380], ["150000.00", 460]],
        [["02/04/2026", 30], ["ATM WDL", 90], ["2000.00", 300], ["148000.00", 460]],
      ]),
    );

    const [table] = tables(model);
    expect(table.headers).toEqual(["Date", "Narration", "Withdrawal", "Deposit", "Balance"]);
    // Row 1 has no Withdrawal cell at all — index-based mapping would shift
    // its Deposit into Withdrawal and its Balance into Deposit.
    expect(table.records[0].cells).toMatchObject({ Deposit: "50000.00", Balance: "150000.00" });
    expect(table.records[0].cells.Withdrawal).toBeUndefined();
    expect(table.records[1].cells).toMatchObject({ Withdrawal: "2000.00", Balance: "148000.00" });
  });

  it("folds a wrapped narration onto the column it renders under", () => {
    const model = build(
      pdfDoc([
        [["Date", 30], ["Narration", 90, 200], ["Deposit", 380], ["Balance", 460]],
        [["01/04/2026", 30], ["SALARY CREDIT", 90], ["50000.00", 380], ["150000.00", 460]],
        [["FROM EXAMPLE EMPLOYER PAYROLL", 90]],
        [["02/04/2026", 30], ["ATM WDL", 90], ["148000.00", 460]],
      ]),
    );

    const [table] = tables(model);
    expect(table.records).toHaveLength(2);
    expect(table.records[0].cells.Narration).toBe("SALARY CREDIT FROM EXAMPLE EMPLOYER PAYROLL");
  });

  it("stops folding before a restated address block swallows the table", () => {
    const model = build(
      pdfDoc([
        [["Date", 30], ["Narration", 90, 200], ["Balance", 460]],
        [["01/04/2026", 30], ["SALARY CREDIT", 90], ["150000.00", 460]],
        [["EXAMPLE BANK LIMITED", 90]],
        [["REGISTERED OFFICE, EXAMPLE CITY", 90]],
        [["CIN X00000XX0000XXX000000", 90]],
        [["GSTIN 00XXXXX0000X0X0", 90]],
      ]),
    );

    const [table] = tables(model);
    // Two lines may fold; the rest must not keep gluing onto the narration.
    expect(table.records[0].cells.Narration!.split(" ").length).toBeLessThan(12);
    expect(table.records[0].cells.Narration).not.toContain("GSTIN");
  });

  it("disambiguates duplicate header text instead of overwriting", () => {
    const model = build(
      pdfDoc([
        [["Particulars", 30], ["Amount", 200], ["Amount", 320]],
        [["Interest", 30], ["1000", 200], ["2000", 320]],
      ]),
    );

    const [table] = tables(model);
    expect(table.headers).toEqual(["Particulars", "Amount", "Amount (2)"]);
    expect(table.records[0].cells).toMatchObject({ Amount: "1000", "Amount (2)": "2000" });
  });
});

describe("Form 26AS PDF: repeated headers and nested sub-tables", () => {
  const OUTER: CellSpec[] = [
    ["Sr. No.", 30],
    ["Name of Deductor", 70],
    ["TAN of Deductor", 200],
    ["Total Amount Paid / Credited(Rs.)", 310],
    ["Total Tax Deducted(Rs.)", 430],
  ];
  const INNER: CellSpec[] = [
    ["Sr. No.", 50],
    ["Section", 90],
    ["Transaction Date", 150],
    ["Status of Booking", 240],
    ["Date of Booking", 330],
    ["Amount Paid / Credited(Rs.)", 430],
  ];

  const doc = pdfDoc([
    OUTER,
    [["1", 30], ["FIRST DEDUCTOR PVT LTD", 70], ["AAAA00000A", 200], ["251040.00", 310], ["0.00", 430]],
    INNER,
    [["1", 50], ["192", 90], ["30-Dec-2022", 150], ["F", 240], ["28-Jan-2023", 330], ["27887.00", 430]],
    [["2", 50], ["192", 90], ["31-Jan-2023", 150], ["F", 240], ["28-Feb-2023", 330], ["27887.00", 430]],
    OUTER, // reprinted at the page break before the next deductor
    [["2", 30], ["SECOND DEDUCTOR LTD", 70], ["BBBB11111B", 200], ["48000.00", 310], ["4800.00", 430]],
    INNER,
    [["1", 50], ["194A", 90], ["30-Jun-2022", 150], ["F", 240], ["15-Jul-2022", 330], ["12000.00", 430]],
  ]);

  it("treats the reprinted header as a continuation, producing ONE table", () => {
    const model = build(doc);
    const top = tables(model).filter((t) => t.headers.includes("Name of Deductor"));
    expect(top).toHaveLength(1);
    expect(top[0].records).toHaveLength(2);
    expect(top[0].records.map((r) => r.cells["Name of Deductor"])).toEqual([
      "FIRST DEDUCTOR PVT LTD",
      "SECOND DEDUCTOR LTD",
    ]);
  });

  it("nests each deductor's transaction breakup under that deductor's record", () => {
    const model = build(doc);
    const [outer] = tables(model).filter((t) => t.headers.includes("Name of Deductor"));

    const first = outer.records[0].children?.[0] as DocTable;
    expect(first.kind).toBe("table");
    expect(first.records).toHaveLength(2);
    expect(first.records[0].cells["Transaction Date"]).toBe("30-Dec-2022");

    const second = outer.records[1].children?.[0] as DocTable;
    expect(second.records).toHaveLength(1);
    expect(second.records[0].cells.Section).toBe("194A");
  });

  it("returns an outdented row to the outer table instead of absorbing it", () => {
    // Same document without the page-break header reprint: the second
    // deductor row follows the first deductor's sub-table directly, and its
    // cells DO land in that sub-table's columns. Only its indent — left of
    // the sub-table's own left edge — says it belongs to the outer table.
    const model = build(
      pdfDoc([
        OUTER,
        [["1", 30], ["FIRST DEDUCTOR PVT LTD", 70], ["AAAA00000A", 200], ["251040.00", 310], ["0.00", 430]],
        INNER,
        [["1", 50], ["192", 90], ["30-Dec-2022", 150], ["F", 240], ["28-Jan-2023", 330], ["27887.00", 430]],
        [["2", 30], ["SECOND DEDUCTOR LTD", 70], ["BBBB11111B", 200], ["48000.00", 310], ["4800.00", 430]],
      ]),
    );

    const [outer] = tables(model).filter((t) => t.headers.includes("Name of Deductor"));
    expect(outer.records.map((r) => r.cells["Name of Deductor"])).toEqual([
      "FIRST DEDUCTOR PVT LTD",
      "SECOND DEDUCTOR LTD",
    ]);
    expect((outer.records[0].children?.[0] as DocTable).records).toHaveLength(1);
  });

  it("terminates instead of nesting the outer and inner tables into each other", () => {
    // The inner scan meets the outer header again; without ancestor tracking
    // it would read that as "a table nested inside me" and recurse forever.
    const model = build(doc);
    expect(tables(model).length).toBe(3); // one outer + two breakups
  });
});

describe("headerless two-column regions", () => {
  it("reads an identity block as key/value, not as a header plus garbage row", () => {
    const model = build(
      pdfDoc([
        [["Name of Assessee", 30], ["SAMPLE TAXPAYER", 200]],
        [["PAN of Assessee", 30], ["AAAPA0000A", 200]],
        [["Assessment Year", 30], ["2023-24", 200]],
      ]),
    );

    expect(tables(model)).toHaveLength(0);
    expect(property(model, /pan of assessee/i)).toBe("AAAPA0000A");
    expect(property(model, /assessment year/i)).toBe("2023-24");
  });

  it("surfaces a second figure on a line rather than discarding it", () => {
    const model = build(
      pdfDoc([
        [["Gross Total Income", 30], ["1,250,000", 300], ["1,100,000", 420]],
        [["Deductions under Chapter VI-A", 30], ["150,000", 300], ["120,000", 420]],
      ]),
    );

    const [block] = model.children.filter((n) => n.kind === "properties");
    expect(block).toBeDefined();
    if (block.kind !== "properties") throw new Error("expected properties");
    expect(block.entries[0]).toMatchObject({
      key: "Gross Total Income",
      value: "1,250,000",
      extras: ["1,100,000"],
    });
  });
});

describe("sections", () => {
  it("nests a computation sheet by indentation under sectionNesting: indent", () => {
    const model = build(
      pdfDoc([
        [["Statement of Income", 30]],
        [["Income from Salary", 45]],
        [["Basic Pay", 65], ["800000", 400]],
        [["House Rent Allowance", 65], ["200000", 400]],
        [["Income from House Property", 45]],
        [["Rent received", 65], ["240000", 400]],
      ]),
      { ...PDF_OPTS, sectionNesting: "indent" },
    );

    const root = model.children[0];
    expect(root.kind).toBe("section");
    if (root.kind !== "section") throw new Error("expected section");
    expect(root.title).toBe("Statement of Income");

    const subs = root.children.filter((n) => n.kind === "section");
    expect(subs.map((s) => (s.kind === "section" ? s.title : ""))).toEqual([
      "Income from Salary",
      "Income from House Property",
    ]);

    const salary = subs[0];
    if (salary.kind !== "section") throw new Error("expected section");
    const props = salary.children[0];
    if (props.kind !== "properties") throw new Error("expected properties");
    expect(props.entries.map((e) => e.key)).toEqual(["Basic Pay", "House Rent Allowance"]);
  });

  it("keeps a section's content when the heading is indented further than its own table", () => {
    // Form 26AS's text export brackets headings in the delimiter, pushing them
    // one synthetic column right of the table they introduce. Under indent
    // nesting the table would close the section it belongs to.
    const model = build(
      pdfDoc([
        [["PART-I - Details of Tax Deducted at Source", 100]],
        [["Sr. No.", 0], ["Name of Deductor", 100], ["Total Tax Deducted(Rs.)", 300]],
        [["1", 0], ["FIRST DEDUCTOR PVT LTD", 100], ["4800.00", 300]],
      ]),
      GRID_OPTS,
    );

    const part = findSection(model, /PART-I/);
    expect(part).not.toBeNull();
    expect(tables(part!.children)).toHaveLength(1);
  });

  it("demotes a heading that opened nothing back to text, keeping the words", () => {
    const model = build(pdfDoc([[["Some trailing note with no content under it", 30]]]));
    expect(model.children[0].kind).toBe("text");
  });
});

describe("page furniture", () => {
  it("drops verbatim repeats but never a repeated table header", () => {
    const header: CellSpec[] = [["Date", 30], ["Narration", 90], ["Amount", 300]];
    const footer: CellSpec[] = [["This is a computer generated statement", 30]];
    const model = build(
      pdfDoc([
        header,
        [["01/04/2026", 30], ["A", 90], ["100", 300]],
        footer,
        header,
        [["02/04/2026", 30], ["B", 90], ["200", 300]],
        footer,
        header,
        [["03/04/2026", 30], ["C", 90], ["300", 300]],
        footer,
      ]),
    );

    const [table] = tables(model);
    expect(table.records).toHaveLength(3);
    expect(JSON.stringify(model)).not.toContain("computer generated");
  });

  /**
   * The layout that broke a real 43-page bank statement: the column header is
   * printed ONCE, on page one, while a three-cell letterhead line is reprinted
   * at the top of every page. Treating that line as a header (it has the shape
   * of one — several text cells, no figures) handed it every transaction from
   * page two onward, keyed by columns with no date among them, and the mapper
   * dropped all of them. 495 of 510 rows were lost this way.
   */
  const letterhead: CellSpec[][] = [
    [["SAMPLE BANK", 292, 60]],
    [["ACCOUNT HOLDER", 34, 80], ["Address", 340, 35], [": 12 SAMPLE ROAD", 397, 80]],
    [["Nomination : Registered", 34, 110], ["Account Type : SAVINGS", 340, 105]],
    [["Email", 340, 25], [": SAMPLE@EXAMPLE.COM", 397, 95]],
    // The line that caused the loss: three text cells, no figures — the exact
    // shape of a column header, and reprinted on every page.
    [["From : 01/04/2025", 34, 64], ["To : 31/03/2026", 154, 56], ["Statement of account", 340, 101]],
  ];
  const statementHeader: CellSpec[] = [
    ["Date", 40, 16], ["Narration", 144, 34], ["Withdrawal", 362, 104], ["Balance", 564, 55],
  ];
  const txns = (n: number): CellSpec[][] => [
    [[`0${n}/04/2025`, 34, 217], [`REF${n}0001`, 289, 102], [`${n}00.00`, 434, 36], [`${n}000.00`, 585, 42]],
    [[`0${n}/04/2025`, 34, 217], [`REF${n}0002`, 289, 102], [`${n}50.00`, 434, 36], [`${n}500.00`, 585, 42]],
  ];
  const statement = () =>
    build(
      pdfDoc([
        ...letterhead, statementHeader, ...txns(1), // page 1 — the only page stating the columns
        ...letterhead, ...txns(2),
        ...letterhead, ...txns(3),
      ]),
    );

  it("continues a table across pages whose header is never reprinted", () => {
    const found = tables(statement()).filter((t) => t.headers.includes("Narration"));

    // One table, not one per page — and every transaction row in it.
    expect(found).toHaveLength(1);
    expect(found[0].records.map((r) => r.cells.Balance)).toEqual([
      "1000.00", "1500.00", "2000.00", "2500.00", "3000.00", "3500.00",
    ]);
  });

  it("keeps a repeated masthead once, as content, rather than dropping every copy", () => {
    // The account identity is real content and belongs in the model — stated
    // once, not once per page.
    const occurrences = JSON.stringify(statement()).split("SAMPLE@EXAMPLE.COM").length - 1;
    expect(occurrences).toBe(1);
  });

  it("never treats a figure-carrying row as a repeat, however often it recurs", () => {
    // A Form 26AS really does list identical transactions: same section, date,
    // status and amount. Dropping them as "repeats" deletes money.
    const row: CellSpec[] = [["194A", 30], ["30-Jun-2025", 120], ["F", 240], ["5000.00", 320]];
    const model = build(
      pdfDoc([
        [["Section", 30], ["Transaction Date", 120], ["Status", 240], ["Amount", 320]],
        row,
        row,
        row,
      ]),
    );

    const [table] = tables(model);
    expect(table.records).toHaveLength(3);
  });

  it("strips a templated footer glued onto a real cell", () => {
    const model = build(
      pdfDoc([
        [["Information Category", 30], ["Amount", 300]],
        [["Salary Download ID : 1234 Generation Date : 01/04/2026, 10:00:00 Page 6 of 7", 30], ["500000", 300]],
      ]),
      {
        ...PDF_OPTS,
        stripPatterns: [/download id\s*:\s*\S*\s*generation date\s*:\s*[\d/]+,?\s*[\d:]+\s*page\s*\d+\s*of\s*\d+/gi],
      },
    );

    const [table] = tables(model);
    expect(table.records[0].cells["Information Category"]).toBe("Salary");
  });
});

describe("delimited text", () => {
  it("detects the delimiter by field-count consistency", () => {
    expect(detectDelimiter("a^b^c\nd^e^f\ng^h^i")).toBe("^");
    expect(detectDelimiter("a\tb\tc\nd\te\tf")).toBe("\t");
  });

  const TEXT_26AS = [
    "^Annual Tax Statement^",
    "",
    "File Creation Date^Permanent Account Number (PAN)^Current Status of PAN^Name of Assessee",
    "17-02-2023^AAAPA0000A^ACTIVE^SAMPLE TAXPAYER",
    "",
    "^PART-I - Details of Tax Deducted at Source^",
    "Sr. No.^Name of Deductor^TAN of Deductor^Total Amount Paid / Credited(Rs.)^Total Tax Deducted(Rs.)",
    "1^FIRST DEDUCTOR PVT LTD^AAAA00000A^251040.00^0.00",
    "^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Amount Paid / Credited(Rs.)",
    "^1^192^30-Dec-2022^F^28-Jan-2023^27887.00",
    "^2^192^31-Jan-2023^F^28-Feb-2023^27887.00",
    "2^SECOND DEDUCTOR LTD^BBBB11111B^48000.00^4800.00",
    "^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Amount Paid / Credited(Rs.)",
    "^1^194A^30-Jun-2022^F^15-Jul-2022^12000.00",
    "",
    "^PART-II - Details of Tax Deducted at Source for 15G / 15H^",
    "No transactions present",
  ].join("\n");

  const model26AS = () =>
    buildDocModel({ doc: fromDelimitedText(TEXT_26AS), filename: "26AS.txt", kind: "txt" }, GRID_OPTS);

  it("reads Form 26AS's text export, nesting by the leading empty field", () => {
    const part = findSection(model26AS(), /PART-I/);
    expect(part).not.toBeNull();

    const [outer] = tables(part!.children).filter((t) => t.headers.includes("Name of Deductor"));
    expect(outer.records).toHaveLength(2);
    expect(outer.records[0].cells["TAN of Deductor"]).toBe("AAAA00000A");

    const inner = outer.records[0].children?.[0];
    expect(inner?.kind).toBe("table");
    if (inner?.kind !== "table") throw new Error("expected nested table");
    expect(inner.records).toHaveLength(2);
    expect(inner.records[0].cells["Transaction Date"]).toBe("30-Dec-2022");
    expect((outer.records[1].children?.[0] as DocTable).records[0].cells.Section).toBe("194A");
  });

  it("does not fold a delimiter-bracketed heading into the table above it", () => {
    const model = model26AS();
    // The identity table sits before "^PART-I...^"; a blank line separates
    // them, so the heading must not become part of that table's only record.
    const [identity] = tables(model).filter((t) => t.headers.includes("Current Status of PAN"));
    expect(identity.records[0].cells["Permanent Account Number (PAN)"]).toBe("AAAPA0000A");
    expect(JSON.stringify(identity)).not.toContain("PART-I");

    expect(findSection(model, /PART-I/)).not.toBeNull();
  });

  it("keeps a trailing heading and its note as text rather than folding them", () => {
    const model = model26AS();
    const trailing = texts(model).map((t) => t.text);
    expect(trailing).toContain("PART-II - Details of Tax Deducted at Source for 15G / 15H");
    expect(trailing).toContain("No transactions present");
  });
});

describe("spreadsheet grids", () => {
  it("structures a downloaded statement workbook the same way as a PDF", () => {
    const model = buildDocModel(
      {
        doc: fromGrids([
          {
            name: "Statement",
            rows: [
              ["Date", "Narration", "Withdrawal", "Deposit", "Balance"],
              ["01/04/2026", "SALARY CREDIT", null, 50000, 150000],
              ["02/04/2026", "ATM WDL", 2000, null, 148000],
            ],
          },
        ]),
        filename: "statement.xlsx",
        kind: "xlsx",
      },
      GRID_OPTS,
    );

    const sheet = findSection(model, /Statement/);
    expect(sheet).not.toBeNull();
    const [table] = tables(sheet!.children);
    expect(table.records).toHaveLength(2);
    expect(table.records[0].cells.Deposit).toBe("50000");
    expect(table.records[0].cells.Withdrawal).toBeUndefined();
  });
});

describe("nothing is silently dropped", () => {
  it("keeps unrecognized regions as text nodes", () => {
    const model = build(
      pdfDoc([
        [["Date", 30], ["Amount", 300]],
        [["01/04/2026", 30], ["100", 300]],
        [["Disclaimer: figures are provisional and subject to revision.", 30]],
      ]),
    );

    expect(JSON.stringify(model)).toContain("Disclaimer");
  });

  it("reports cell text that landed in no column instead of discarding it", () => {
    const model = build(
      pdfDoc([
        [["Date", 30], ["Amount", 300]],
        [["01/04/2026", 30], ["100", 300], ["STRAY", 900]],
      ]),
    );

    const [table] = tables(model);
    expect(table.records[0].cells).toMatchObject({ Date: "01/04/2026", Amount: "100" });
    expect(JSON.stringify(model)).toContain("01/04/2026");
  });
});
