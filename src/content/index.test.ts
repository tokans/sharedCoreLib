import { describe, it, expect, beforeEach } from "vitest";
import {
  totalDurationSec,
  formatDuration,
  mergeEntries,
  bundleEntries,
  focusTags,
  stepImage,
  mergeTypes,
  collectBakedTypes,
  findContentType,
  contentBundleSchema,
  contentTypeMetaSchema,
  createContentStore,
  createContentSync,
  type ContentEntry,
  type ContentBundle,
  type ContentType,
  type ContentTypeMeta,
} from "./index.js";

const entry = (id: string, over: Partial<ContentEntry> = {}): ContentEntry => ({
  id,
  name: id,
  summary: "s",
  source: "baked",
  steps: [],
  ...over,
});

describe("pure helpers", () => {
  it("sums + formats durations", () => {
    const e = entry("a", { steps: [{ title: "x", instruction: "i", durationSec: 30 }, { title: "y", instruction: "i" }, { title: "z", instruction: "i", durationSec: 90 }] });
    expect(totalDurationSec(e)).toBe(120);
    expect([formatDuration(0), formatDuration(45), formatDuration(60), formatDuration(125)]).toEqual(["—", "45s", "1m", "2m 5s"]);
  });

  it("merges entries (baked wins id collisions) and flattens bundles", () => {
    const merged = mergeEntries([entry("a", { name: "Baked" })], [entry("a", { name: "Bundle", source: "bundle" }), entry("b", { source: "bundle" })]);
    expect(merged.map((e) => e.id)).toEqual(["a", "b"]);
    expect(merged[0]!.name).toBe("Baked");

    const bundles: ContentBundle[] = [{ bundleId: "p", name: "P", version: 1, entries: [entry("p1"), entry("p2")] }];
    const flat = bundleEntries(bundles);
    expect(flat.every((e) => e.source === "bundle" && e.bundleId === "p")).toBe(true);
  });

  it("stepImage + focusTags", () => {
    expect(stepImage({ title: "x", instruction: "i", image: "data:image/svg+xml,x" })).toBe("data:image/svg+xml,x");
    expect(focusTags([entry("a", { focus: "x" }), entry("b", { focus: "y" }), entry("c", { focus: "x" }), entry("d")])).toEqual(["x", "y"]);
  });
});

describe("schemas gate OTA payloads", () => {
  const goodBundle = { bundleId: "p", name: "Pack", version: 1, entries: [{ id: "e1", name: "E", summary: "s", steps: [{ title: "a", instruction: "b", durationSec: 30 }] }] };
  it("accepts a good bundle, rejects unsafe image urls", () => {
    expect(contentBundleSchema.parse(goodBundle).bundleId).toBe("p");
    const bad = { ...goodBundle, entries: [{ ...goodBundle.entries[0], steps: [{ title: "a", instruction: "b", image: "javascript:1" }] }] };
    expect(() => contentBundleSchema.parse(bad)).toThrow();
  });
  it("validates a type meta and rejects a bad key", () => {
    const meta = { key: "meditation", label: "Meditation", iconName: "Brain", tier: "tracker", releaseTag: "content-meditation-latest" };
    expect(contentTypeMetaSchema.parse(meta).key).toBe("meditation");
    expect(() => contentTypeMetaSchema.parse({ ...meta, key: "Bad Key!" })).toThrow();
  });
});

describe("registry merge (icon-agnostic)", () => {
  type Icon = string;
  const baked: ContentType<Icon>[] = [
    { key: "yoga", label: "Yoga", icon: "FlowerIcon", tier: "tracker", releaseTag: "content-yoga-latest", entryNoun: "sequence", order: 10, samples: [entry("y1")], source: "baked" },
  ];
  const remote: ContentTypeMeta = { key: "meditation", label: "Meditation", iconName: "Brain", tier: "tracker", releaseTag: "content-meditation-latest", order: 30 };
  const resolveIcon = (name: string) => `icon:${name}`;

  it("collectBakedTypes sorts by order then label", () => {
    const mods = { "/content/b/index.ts": { default: { ...baked[0]!, key: "b", order: 20 } }, "/content/a/index.ts": { default: { ...baked[0]!, key: "a", order: 10 } } };
    expect(collectBakedTypes(mods).map((t) => t.key)).toEqual(["a", "b"]);
  });

  it("adds remote-only types (resolving the icon) and lets baked win collisions", () => {
    const merged = mergeTypes(baked, [remote, { ...remote, key: "yoga", label: "Remote Yoga" }], resolveIcon);
    expect(findContentType(merged, "meditation")!.icon).toBe("icon:Brain");
    expect(findContentType(merged, "meditation")!.source).toBe("remote");
    expect(findContentType(merged, "yoga")!.label).toBe("Yoga"); // baked wins
  });
});

describe("createContentStore", () => {
  const useStore = createContentStore({ storageKey: "test.content" });
  beforeEach(() => useStore.setState({ bundlesByType: {}, availableByType: {}, revisionByType: {}, remoteTypes: [], catalogRevision: 0, lastCheckedAt: 0 }));

  it("install/remove via the available catalog (removing keeps it available to re-add)", () => {
    const b = (id: string): ContentBundle => ({ bundleId: id, name: id, version: 1, entries: [] });
    useStore.getState().setAvailable("yoga", [b("a"), b("c")]);
    expect(useStore.getState().bundlesByType.yoga ?? []).toEqual([]); // available ≠ installed
    useStore.getState().installBundle("yoga", "a");
    expect((useStore.getState().bundlesByType.yoga ?? []).map((x) => x.bundleId)).toEqual(["a"]);
    useStore.getState().installBundle("yoga", "missing"); // no-op when not available
    expect((useStore.getState().bundlesByType.yoga ?? []).map((x) => x.bundleId)).toEqual(["a"]);
    useStore.getState().removeBundle("yoga", "a"); // uninstall, but still available
    expect(useStore.getState().bundlesByType.yoga).toEqual([]);
    expect((useStore.getState().availableByType.yoga ?? []).map((x) => x.bundleId)).toEqual(["a", "c"]);
    useStore.getState().installBundle("yoga", "a"); // re-add from available
    expect((useStore.getState().bundlesByType.yoga ?? []).map((x) => x.bundleId)).toEqual(["a"]);
  });

  it("upserts/removes bundles per type and registers remote types", () => {
    const b = (id: string, version = 1): ContentBundle => ({ bundleId: id, name: id, version, entries: [] });
    useStore.getState().upsertBundle("yoga", b("a", 1));
    useStore.getState().upsertBundle("yoga", b("a", 2));
    useStore.getState().upsertBundle("exercises", b("c"));
    expect(useStore.getState().bundlesByType.yoga).toHaveLength(1);
    expect(useStore.getState().bundlesByType.yoga![0]!.version).toBe(2);
    expect(useStore.getState().bundlesByType.exercises).toHaveLength(1);
    useStore.getState().removeBundle("yoga", "a");
    expect(useStore.getState().bundlesByType.yoga).toEqual([]);

    useStore.getState().registerRemoteType({ key: "m", label: "M", iconName: "Brain", tier: "tracker", releaseTag: "content-m-latest" });
    useStore.getState().registerRemoteType({ key: "m", label: "M2", iconName: "Brain", tier: "tracker", releaseTag: "content-m-latest" });
    expect(useStore.getState().remoteTypes).toHaveLength(1);
    expect(useStore.getState().remoteTypes[0]!.label).toBe("M2");
  });
});

describe("createContentSync", () => {
  const useStore = createContentStore({ storageKey: "test.sync" });
  const sync = createContentSync({
    store: useStore,
    listTypes: () => [{ key: "yoga", releaseTag: "content-yoga-latest" }],
    baseUrl: "https://example/releases/download",
    catalogTag: "content-catalog-latest",
    pubkeyHex: "",
    transportKeyB64: "",
    appVersion: "0.1.0",
  });

  it("is not configured without keys and no-ops (outside Tauri)", async () => {
    expect(sync.isConfigured()).toBe(false);
    expect(sync.canRun()).toBe(false);
    expect(await sync.runContentSync({ force: true })).toBe(false);
    expect(await sync.checkTypeNow({ key: "yoga", releaseTag: "content-yoga-latest" })).toBe(false);
  });

  it("canRun via an injected fetchBytes (browser dev) and fails soft when the fetch errors", async () => {
    const store = createContentStore({ storageKey: "test.sync.browser" });
    const s = createContentSync({
      store,
      listTypes: () => [{ key: "yoga", releaseTag: "content-yoga-latest" }],
      baseUrl: "https://example/releases/download",
      catalogTag: "content-catalog-latest",
      pubkeyHex: "aa",
      transportKeyB64: "bb",
      appVersion: "0.1.0",
      fetchBytes: async () => {
        throw new Error("offline");
      },
    });
    expect(s.canRun()).toBe(true); // configured + injected fetch ⇒ can run outside Tauri
    expect(await s.runContentSync({ force: true })).toBe(false); // fetch throws ⇒ best-effort false
  });
});
