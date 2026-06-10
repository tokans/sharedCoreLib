import { describe, it, expect } from "vitest";
import type { SqlDb } from "../db/index.js";
import {
  ICE_CARD_SCHEMA, createIceStore, iceCardPersonKey, slugifyName, type IceCard,
} from "./index.js";

/** In-memory fake SqlDb backing a single ICE table keyed by person_key. */
function fakeDb() {
  const rows = new Map<string, IceCard>();
  const calls = { execute: [] as string[] };
  const db: SqlDb = {
    select: async (sql, params) => {
      if (/WHERE person_key/.test(sql)) {
        const r = rows.get(String((params as unknown[])[0]));
        return (r ? [r] : []) as never;
      }
      return [...rows.values()] as never;
    },
    execute: async (sql, params) => {
      calls.execute.push(sql);
      const p = (params ?? []) as unknown[];
      if (/^INSERT OR REPLACE/.test(sql)) {
        // Column order matches the INSERT built by the store (parse the (col, col, …) list).
        const colList = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")"));
        const cols = [...colList.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
        const row: Record<string, unknown> = {};
        cols.forEach((c, i) => (row[c] = p[i]));
        rows.set(String(row.person_key), row as IceCard);
      } else if (/^DELETE/.test(sql)) {
        rows.delete(String(p[0]));
      }
      return {};
    },
  };
  return { db, calls };
}

describe("common ICE card schema", () => {
  it("is a common-owned shared table with a person_key key", () => {
    expect(ICE_CARD_SCHEMA.owner).toBe("common");
    expect(ICE_CARD_SCHEMA.shared).toBe(true);
    expect(ICE_CARD_SCHEMA.fields.find((f) => f.keyField)?.name).toBe("person_key");
  });
});

describe("createIceStore", () => {
  it("ensure → upsert → get/list round-trip", async () => {
    const { db, calls } = fakeDb();
    const store = createIceStore(db);
    await store.ensure();
    expect(calls.execute.some((s) => /CREATE TABLE IF NOT EXISTS "common_ice_card"/.test(s))).toBe(true);

    await store.upsert({ person_key: "self", display_name: "Ada", blood_group: "O+", organ_donor: 1, source_app: "myHealth" });
    const card = await store.get("self");
    expect(card?.display_name).toBe("Ada");
    expect(card?.blood_group).toBe("O+");
    expect(card?.organ_donor).toBe(1);

    await store.upsert({ person_key: "kid-sam", display_name: "Sam", source_app: "myHealth" });
    expect(await store.list()).toHaveLength(2);

    await store.remove("kid-sam");
    expect(await store.list()).toHaveLength(1);
    expect(await store.get("kid-sam")).toBeNull();
  });

  it("upsert replaces an existing card (either app can edit)", async () => {
    const { db } = fakeDb();
    const store = createIceStore(db);
    await store.upsert({ person_key: "self", contact_name: "Mom", source_app: "myHealth" });
    await store.upsert({ person_key: "self", contact_name: "Dad", source_app: "myFinance" });
    const card = await store.get("self");
    expect(card?.contact_name).toBe("Dad");
    expect(card?.source_app).toBe("myFinance");
  });
});

describe("person key", () => {
  it("self → 'self', others → name slug", () => {
    expect(iceCardPersonKey({ isSelf: true, name: "Ada Lovelace" })).toBe("self");
    expect(iceCardPersonKey({ isSelf: false, name: "Sam O'Neil" })).toBe("sam-o-neil");
    expect(slugifyName("  Jean-Luc  Picard ")).toBe("jean-luc-picard");
  });
});
