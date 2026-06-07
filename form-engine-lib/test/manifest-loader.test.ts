import { describe, it, expect, vi } from "vitest";
import { loadManifest } from "../src/libs/manifest-loader";

describe("loadManifest", () => {
  it("returns a plain object unchanged", async () => {
    const obj = { manifest_id: "m", forms: {} };
    const out = await loadManifest(obj as any);
    expect(out.manifest_id).toBe("m");
  });

  it("parses inline YAML", async () => {
    const yaml = `manifest_id: inline\nforms:\n  contact:\n    title: Contact\n    version: "1.0.0"\n    layout: { type: single-page }`;
    const out = await loadManifest(yaml);
    expect(out.manifest_id).toBe("inline");
    expect((out.forms as any).contact.title).toBe("Contact");
  });

  it("parses inline JSON", async () => {
    const out = await loadManifest('{"manifest_id":"j","forms":{}}');
    expect(out.manifest_id).toBe("j");
  });

  it("rejects unsafe URL protocols (SSRF guard)", async () => {
    await expect(loadManifest("ftp://evil.example/manifest.yaml")).rejects.toThrow();
  });

  it("fetches an http(s) URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '{"manifest_id":"remote","forms":{}}',
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await loadManifest("https://cdn.example.com/m.json");
    expect(out.manifest_id).toBe("remote");
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
