import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore, type MemoryEntry } from "../memory-store.js";
import { LinkStore } from "../links/link-store.js";

import { clusterEpisodes } from "./clustering.js";

interface Harness {
  memoryStore: MemoryStore;
  linkStore: LinkStore;
  dispose: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "atomic-cluster-"));
  const memoryStore = new MemoryStore({
    dbFile: join(dir, "memory.sqlite"),
    maxEntries: 100,
  });
  const linkStore = new LinkStore({
    db: memoryStore.getDatabaseHandleForEmbeddings(),
  });
  return {
    memoryStore,
    linkStore,
    dispose: () => {
      memoryStore.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seed(h: Harness, content: string, tags: string[] = []): MemoryEntry {
  return h.memoryStore.store({ content, source: "agent", tags });
}

describe("clusterEpisodes (phase 5)", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.dispose();
  });

  it("returns no clusters when the candidate set is empty", () => {
    const out = clusterEpisodes(
      [],
      { minClusterSize: 2, requireSharedTag: false, maxClusters: 5 },
      { linkStore: h.linkStore },
    );
    expect(out).toEqual([]);
  });

  it("emits one connected component above the size floor", () => {
    const a = seed(h, "note A", ["pnpm"]);
    const b = seed(h, "note B", ["pnpm"]);
    const c = seed(h, "note C", ["pnpm"]);
    h.linkStore.add({ fromId: a.id, toId: b.id, kind: "RELATES_TO" });
    h.linkStore.add({ fromId: b.id, toId: c.id, kind: "RELATES_TO" });

    const clusters = clusterEpisodes(
      [a, b, c],
      { minClusterSize: 3, requireSharedTag: false, maxClusters: 5 },
      { linkStore: h.linkStore },
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members).toEqual([a.id, b.id, c.id]);
  });

  it("drops components below the size floor", () => {
    const a = seed(h, "note A");
    const b = seed(h, "note B");
    const c = seed(h, "note C");
    h.linkStore.add({ fromId: a.id, toId: b.id, kind: "RELATES_TO" });
    // C is isolated.
    void c;

    const clusters = clusterEpisodes(
      [a, b, c],
      { minClusterSize: 3, requireSharedTag: false, maxClusters: 5 },
      { linkStore: h.linkStore },
    );
    expect(clusters).toEqual([]);
  });

  it("ignores edges to nodes outside the candidate set", () => {
    const a = seed(h, "note A");
    const b = seed(h, "note B");
    const outsider = seed(h, "note outside");
    h.linkStore.add({ fromId: a.id, toId: b.id, kind: "RELATES_TO" });
    h.linkStore.add({
      fromId: a.id,
      toId: outsider.id,
      kind: "RELATES_TO",
    });

    const clusters = clusterEpisodes(
      [a, b],
      { minClusterSize: 2, requireSharedTag: false, maxClusters: 5 },
      { linkStore: h.linkStore },
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members).toEqual([a.id, b.id]);
  });

  it("requires shared tag and trims members lacking the majority tag (CC + tag-intersection)", () => {
    const a = seed(h, "note A", ["pnpm", "tooling"]);
    const b = seed(h, "note B", ["pnpm"]);
    const c = seed(h, "note C", ["pnpm"]);
    const d = seed(h, "note D", ["debug"]);
    h.linkStore.add({ fromId: a.id, toId: b.id, kind: "RELATES_TO" });
    h.linkStore.add({ fromId: b.id, toId: c.id, kind: "RELATES_TO" });
    h.linkStore.add({ fromId: c.id, toId: d.id, kind: "RELATES_TO" });

    const clusters = clusterEpisodes(
      [a, b, c, d],
      { minClusterSize: 3, requireSharedTag: true, maxClusters: 5 },
      { linkStore: h.linkStore },
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members).toEqual([a.id, b.id, c.id]);
    expect(clusters[0]?.sharedTags).toEqual(["pnpm"]);
  });

  it("drops CCs that have no shared tag at all when requireSharedTag=true", () => {
    const a = seed(h, "note A");
    const b = seed(h, "note B");
    const c = seed(h, "note C");
    h.linkStore.add({ fromId: a.id, toId: b.id, kind: "RELATES_TO" });
    h.linkStore.add({ fromId: b.id, toId: c.id, kind: "RELATES_TO" });

    const clusters = clusterEpisodes(
      [a, b, c],
      { minClusterSize: 3, requireSharedTag: true, maxClusters: 5 },
      { linkStore: h.linkStore },
    );
    expect(clusters).toEqual([]);
  });

  it("respects maxClusters cap and emits clusters in deterministic id order", () => {
    // Build two disconnected components.
    const a = seed(h, "note A", ["x"]);
    const b = seed(h, "note B", ["x"]);
    const c = seed(h, "note C", ["x"]);
    const d = seed(h, "note D", ["y"]);
    const e = seed(h, "note E", ["y"]);
    const f = seed(h, "note F", ["y"]);
    h.linkStore.add({ fromId: a.id, toId: b.id, kind: "RELATES_TO" });
    h.linkStore.add({ fromId: b.id, toId: c.id, kind: "RELATES_TO" });
    h.linkStore.add({ fromId: d.id, toId: e.id, kind: "RELATES_TO" });
    h.linkStore.add({ fromId: e.id, toId: f.id, kind: "RELATES_TO" });

    const clusters = clusterEpisodes(
      [a, b, c, d, e, f],
      { minClusterSize: 3, requireSharedTag: true, maxClusters: 1 },
      { linkStore: h.linkStore },
    );
    expect(clusters).toHaveLength(1);
    // Lowest id (a) goes first.
    expect(clusters[0]?.members).toEqual([a.id, b.id, c.id]);
  });

  it("walks edges bidirectionally (incoming + outgoing)", () => {
    const a = seed(h, "note A", ["pnpm"]);
    const b = seed(h, "note B", ["pnpm"]);
    const c = seed(h, "note C", ["pnpm"]);
    // Only c -> a and c -> b; a/b have no outgoing links, but the BFS
    // should still find the CC via incoming.
    h.linkStore.add({ fromId: c.id, toId: a.id, kind: "RELATES_TO" });
    h.linkStore.add({ fromId: c.id, toId: b.id, kind: "RELATES_TO" });

    const clusters = clusterEpisodes(
      [a, b, c],
      { minClusterSize: 3, requireSharedTag: false, maxClusters: 5 },
      { linkStore: h.linkStore },
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members).toEqual([a.id, b.id, c.id]);
  });
});
