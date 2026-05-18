import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../../native/load-better-sqlite3.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations } from "../memory-schema.js";

import { LinkStore, LinkValidationError } from "./link-store.js";

describe("LinkStore", () => {
  let tmp: string;
  let db: Database.Database;
  let store: LinkStore;
  let insertMem: Database.Statement;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-links-"));
    db = new DatabaseCtor(join(tmp, "memory.sqlite"));
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
    insertMem = db.prepare(
      "INSERT INTO memories (content, created_at, updated_at, source) VALUES (?, 1, 1, 'agent') RETURNING id",
    );
    store = new LinkStore({ db, now: () => 1_000 });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const newId = (content = "x"): number =>
    (insertMem.get(content) as { id: number }).id;

  it("inserts a link and reads it back", () => {
    const a = newId();
    const b = newId();
    const row = store.add({ fromId: a, toId: b, kind: "RELATES_TO" });
    expect(row.fromId).toBe(a);
    expect(row.toId).toBe(b);
    expect(row.kind).toBe("RELATES_TO");
    expect(row.weight).toBe(1.0);
    const got = store.get(a, b, "RELATES_TO");
    expect(got).not.toBeNull();
    expect(got?.weight).toBe(1.0);
  });

  it("rejects self-loops", () => {
    const a = newId();
    expect(() =>
      store.add({ fromId: a, toId: a, kind: "RELATES_TO" }),
    ).toThrow(LinkValidationError);
  });

  it("rejects unknown link kinds", () => {
    const a = newId();
    const b = newId();
    expect(() =>
      store.add({
        fromId: a,
        toId: b,
        // @ts-expect-error - intentionally invalid
        kind: "BOGUS_KIND",
      }),
    ).toThrow(LinkValidationError);
  });

  it("rejects non-positive ids", () => {
    expect(() =>
      store.add({ fromId: 0, toId: 1, kind: "RELATES_TO" }),
    ).toThrow(LinkValidationError);
    expect(() =>
      store.add({ fromId: 1, toId: -5, kind: "RELATES_TO" }),
    ).toThrow(LinkValidationError);
  });

  it("upserts on (from,to,kind) conflict, refreshing weight + created_at", () => {
    const a = newId();
    const b = newId();
    store.add({ fromId: a, toId: b, kind: "RELATES_TO", weight: 0.4 });
    const updatedStore = new LinkStore({ db, now: () => 9_999 });
    updatedStore.add({ fromId: a, toId: b, kind: "RELATES_TO", weight: 0.9 });
    const row = updatedStore.get(a, b, "RELATES_TO");
    expect(row?.weight).toBe(0.9);
    expect(row?.createdAt).toBe(9_999);
    expect(updatedStore.count()).toBe(1);
  });

  it("clamps weight to [0, 1]", () => {
    const a = newId();
    const b = newId();
    const c = newId();
    expect(
      store.add({ fromId: a, toId: b, kind: "RELATES_TO", weight: 2.5 })
        .weight,
    ).toBe(1);
    expect(
      store.add({ fromId: a, toId: c, kind: "RELATES_TO", weight: -1 })
        .weight,
    ).toBe(0);
  });

  it("allows multiple kinds between the same pair", () => {
    const a = newId();
    const b = newId();
    store.add({ fromId: a, toId: b, kind: "RELATES_TO" });
    store.add({ fromId: a, toId: b, kind: "CAUSED_BY" });
    expect(store.count()).toBe(2);
    expect(store.listOutgoing(a)).toHaveLength(2);
  });

  it("listOutgoing/listIncoming filters by kind subset", () => {
    const a = newId();
    const b = newId();
    const c = newId();
    store.add({ fromId: a, toId: b, kind: "RELATES_TO" });
    store.add({ fromId: a, toId: c, kind: "CAUSED_BY" });
    expect(store.listOutgoing(a)).toHaveLength(2);
    expect(store.listOutgoing(a, ["RELATES_TO"])).toHaveLength(1);
    expect(store.listIncoming(c)).toHaveLength(1);
    expect(store.listIncoming(c, ["RELATES_TO"])).toHaveLength(0);
  });

  it("FK cascade drops dependent edges on memory deletion", () => {
    const a = newId();
    const b = newId();
    store.add({ fromId: a, toId: b, kind: "RELATES_TO" });
    expect(store.count()).toBe(1);
    db.prepare("DELETE FROM memories WHERE id = ?").run(a);
    expect(store.count()).toBe(0);
  });

  describe("expand", () => {
    let ids: number[];

    beforeEach(() => {
      // Build a chain: 1 -> 2 -> 3 -> 4 -> 5, plus 2 <-> 6
      ids = [newId(), newId(), newId(), newId(), newId(), newId()];
      store.add({ fromId: ids[0]!, toId: ids[1]!, kind: "RELATES_TO" });
      store.add({ fromId: ids[1]!, toId: ids[2]!, kind: "RELATES_TO" });
      store.add({ fromId: ids[2]!, toId: ids[3]!, kind: "RELATES_TO" });
      store.add({ fromId: ids[3]!, toId: ids[4]!, kind: "RELATES_TO" });
      store.add({ fromId: ids[5]!, toId: ids[1]!, kind: "REFERENCES" });
    });

    it("returns empty result for empty seed", () => {
      expect(store.expand([], { depth: 3 })).toEqual([]);
    });

    it("walks one hop in both directions by default", () => {
      const out = store.expand([ids[1]!], { depth: 1 });
      // Outgoing: 2->3 ; Incoming: 1->2, 6->2
      expect(new Set(out)).toEqual(new Set([ids[0], ids[2], ids[5]]));
    });

    it("respects depth=2", () => {
      const out = store.expand([ids[0]!], { depth: 2 });
      // hop 1: 1->2 ; hop 2: 2->3 + 6->2 already seen
      expect(new Set(out)).toContain(ids[1]);
      expect(new Set(out)).toContain(ids[2]);
      expect(new Set(out)).toContain(ids[5]);
    });

    it("clamps depth to [1, 3]", () => {
      const out = store.expand([ids[0]!], { depth: 99 });
      // BFS termination via maxExpanded or no more frontier — chain has 5 nodes
      expect(out.length).toBeLessThanOrEqual(5);
      expect(out.length).toBeGreaterThan(0);
    });

    it("excludes seed ids from result", () => {
      const out = store.expand([ids[1]!], { depth: 1 });
      expect(out).not.toContain(ids[1]);
    });

    it("dedupes when multiple seeds share neighbours", () => {
      const out = store.expand([ids[0]!, ids[2]!], { depth: 1 });
      // ids[1] is neighbour of both — should appear once
      const counts = new Map<number, number>();
      for (const id of out) counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const v of counts.values()) expect(v).toBe(1);
    });

    it("respects maxExpanded cap", () => {
      const out = store.expand([ids[0]!], { depth: 3, maxExpanded: 2 });
      expect(out.length).toBe(2);
    });

    it("can filter by link kind", () => {
      const out = store.expand([ids[1]!], { depth: 1, kinds: ["REFERENCES"] });
      // Only the 6->2 REFERENCES edge survives the kind filter
      expect(out).toEqual([ids[5]]);
    });
  });

  it("remove() returns true when an edge existed, false otherwise", () => {
    const a = newId();
    const b = newId();
    store.add({ fromId: a, toId: b, kind: "RELATES_TO" });
    expect(store.remove(a, b, "RELATES_TO")).toBe(true);
    expect(store.remove(a, b, "RELATES_TO")).toBe(false);
  });
});
