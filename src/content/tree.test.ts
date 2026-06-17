import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import {
  buildContentTree,
  buildContentTreeFromGlob,
  buildNodeTree,
  parseSimpleYaml,
  parseProperty,
  nodeAt,
  nodeLabel,
  nodeOrder,
  nodeEntries,
  propData,
  prop,
  leaves,
  type RawFile,
} from "./tree.js";

// Extensions read as text; everything else becomes a file-reference property.
const TEXT = new Set(["json", "yaml", "yml", "txt", "text", "md", "svg", "html", "csv", "xml"]);

/** Walk a fixture dir into RawFile[] (text for text files, undefined for binary). */
function gather(root: string): RawFile[] {
  const out: RawFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
      const path = relative(root, abs).split(sep).join("/");
      out.push({ path, text: TEXT.has(ext) ? readFileSync(abs, "utf8") : undefined });
    }
  };
  walk(root);
  return out;
}

const fixture = (name: string) => fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));

describe("parseSimpleYaml", () => {
  it("parses a flat map of scalars", () => {
    expect(parseSimpleYaml("tier: tracker\norder: 10\nentryNoun: sequence")).toEqual({
      tier: "tracker",
      order: 10,
      entryNoun: "sequence",
    });
  });
  it("parses nested maps and scalar lists", () => {
    expect(parseSimpleYaml("label: Science\narea: STEM\ntopics:\n  - Physics\n  - Chemistry")).toEqual({
      label: "Science",
      area: "STEM",
      topics: ["Physics", "Chemistry"],
    });
  });
});

describe("parseProperty (by extension)", () => {
  it("classifies json / yaml / text / file", () => {
    expect(parseProperty({ path: "a/meta.json", text: '{"x":1}' })).toEqual({ kind: "json", value: { x: 1 } });
    expect(parseProperty({ path: "a/m.yaml", text: "x: 1" })).toEqual({ kind: "yaml", value: { x: 1 } });
    expect(parseProperty({ path: "a/title.txt", text: "Hi" })).toEqual({ kind: "text", value: "Hi" });
    expect(parseProperty({ path: "a/cover.png", url: "blob:abc" })).toEqual({
      kind: "file",
      path: "a/cover.png",
      ext: "png",
      url: "blob:abc",
    });
  });
});

describe("myEducation deep tree (board/class/subject/book)", () => {
  const root = buildContentTree(gather(fixture("myeducation-tree")), { rootKey: "myeducation" });

  it("nests to arbitrary depth with the right leaves", () => {
    expect(root.children.map((c) => c.key)).toEqual(["cbse", "icse"]); // baked + sorted by label
    const book = nodeAt(root, ["cbse", "class-10", "science", "ncert-physics"]);
    expect(book).toBeTruthy();
    expect(book!.depth).toBe(4);
    expect(book!.isLeaf).toBe(true);
    expect(nodeLabel(book!)).toBe("NCERT Physics");
  });

  it("reads interim-node properties: text (name), json (meta), yaml (label w/ list)", () => {
    const cbse = nodeAt(root, ["cbse"])!;
    expect(nodeLabel(cbse)).toBe("CBSE"); // name.txt
    expect(propData(cbse, "meta")).toMatchObject({ country: "India", fullName: expect.stringContaining("Central") });

    const science = nodeAt(root, ["cbse", "class-10", "science"])!;
    expect(propData(science, "label")).toEqual({
      label: "Science",
      area: "STEM",
      credits: 5,
      topics: ["Physics", "Chemistry", "Biology"],
    });
  });

  it("treats a binary interim file as a file-reference property (never read as text)", () => {
    const class10 = nodeAt(root, ["cbse", "class-10"])!;
    expect(nodeOrder(class10)).toBe(10); // order.txt
    expect(prop(class10, "cover")).toEqual({ kind: "file", path: expect.stringMatching(/cover\.png$/), ext: "png", url: undefined });
  });

  it("extracts leaf content from entries.json + orders siblings by `order`", () => {
    const science = nodeAt(root, ["cbse", "class-10", "science"])!;
    expect(science.children.map((c) => c.key)).toEqual(["ncert-physics", "ncert-chemistry"]); // order 1, 2
    const physics = nodeAt(root, ["cbse", "class-10", "science", "ncert-physics"])!;
    const entries = nodeEntries(physics);
    expect(entries.map((e) => e.id)).toEqual(["phy10-light", "phy10-electricity"]);
    expect(entries[0]!.steps.length).toBe(2);
    // Deepest branch on the other board still reachable.
    expect(nodeAt(root, ["icse", "class-9", "physics", "selina-physics"])!.depth).toBe(4);
  });
});

describe("myHealth shallow tree (type/leaf)", () => {
  const root = buildContentTree(gather(fixture("myhealth-tree")), { rootKey: "myhealth" });

  it("has interim type nodes with properties and leaf subcategories with content", () => {
    const yoga = nodeAt(root, ["yoga"])!;
    expect(yoga.isLeaf).toBe(false);
    expect(nodeLabel(yoga)).toBe("Yoga"); // label.txt
    expect(propData(yoga, "meta")).toEqual({ tier: "tracker", order: 10, entryNoun: "sequence" }); // meta.yaml

    const morning = nodeAt(root, ["yoga", "morning"])!;
    expect(morning.isLeaf).toBe(true);
    expect(nodeLabel(morning)).toBe("Morning Flows");
    expect(nodeEntries(morning).map((e) => e.id)).toEqual(["yoga-morning-wake-up"]);
  });

  it("exposes every leaf across types", () => {
    expect(leaves(root).map((l) => l.key).sort()).toEqual(["evening", "morning", "strength"]);
  });
});

describe("buildNodeTree (inline subtypes → tree)", () => {
  const tree = buildNodeTree({
    key: "yoga",
    label: "Yoga",
    children: [
      { key: "evening", label: "Wind-down", order: 2, entries: [{ id: "e", name: "Unwind", summary: "s", source: "baked", steps: [{ title: "Fold", instruction: "i" }] }] },
      { key: "morning", label: "Morning Flow", order: 1, entries: [{ id: "m", name: "Wake-Up", summary: "s", source: "baked", steps: [{ title: "Mountain", instruction: "i" }] }] },
    ],
  });

  it("builds a navigable node tree, sorted by order, with leaf entries", () => {
    expect(nodeLabel(tree)).toBe("Yoga");
    expect(tree.isLeaf).toBe(false);
    expect(tree.children.map((c) => c.key)).toEqual(["morning", "evening"]); // order 1, 2
    const morning = nodeAt(tree, ["morning"])!;
    expect(morning.isLeaf).toBe(true);
    expect(morning.depth).toBe(1);
    expect(nodeEntries(morning).map((e) => e.id)).toEqual(["m"]);
  });
});

describe("buildContentTreeFromGlob (Vite glob map → tree)", () => {
  it("strips the prefix and folds an inline file map", () => {
    const root = buildContentTreeFromGlob(
      {
        "/content/yoga/label.txt": "Yoga",
        "/content/yoga/morning/entries.json": '[{"id":"a","name":"A","summary":"s","steps":[{"title":"t","instruction":"i"}]}]',
      },
      { assets: { "/content/yoga/cover.png": "blob:xyz" } },
    );
    expect(nodeLabel(nodeAt(root, ["yoga"])!)).toBe("Yoga");
    expect(prop(nodeAt(root, ["yoga"])!, "cover")).toMatchObject({ kind: "file", url: "blob:xyz" });
    expect(nodeEntries(nodeAt(root, ["yoga", "morning"])!).map((e) => e.id)).toEqual(["a"]);
  });
});
