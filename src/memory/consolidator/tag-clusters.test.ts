import { describe, expect, it } from "vitest";

import type { MemoryEntry } from "../memory-store.js";

import { TAG_CLUSTER_MAX_MEMBERS, clusterByTag } from "./tag-clusters.js";

function note(id: number, tags: string[]): MemoryEntry {
  return {
    id,
    content: `note ${id}`,
    createdAt: 0,
    updatedAt: 0,
    source: "agent",
    sessionId: null,
    workingDir: null,
    tags,
    recallCount: 0,
    lastRecalledAt: null,
  };
}

describe("clusterByTag (#903)", () => {
  it("groups notes that share a topic tag", () => {
    const out = clusterByTag(
      [note(1, ["pnpm"]), note(2, ["pnpm"]), note(3, ["pnpm"]), note(4, ["git"])],
      3,
      5,
    );
    expect(out).toEqual([{ members: [1, 2, 3], sharedTags: ["pnpm"] }]);
  });

  it("never groups by the provenance tags `reflection` and `superseded`", () => {
    const out = clusterByTag(
      [
        note(1, ["reflection", "superseded"]),
        note(2, ["reflection", "superseded"]),
        note(3, ["reflection", "superseded"]),
      ],
      3,
      5,
    );
    expect(out).toEqual([]);
  });

  it("takes the rarer tag first and puts each note in one group only", () => {
    // `docker` is held by 3 notes, `build` by 6. Notes 1-3 carry both;
    // they go to the narrower `docker` group, and `build` is left with
    // notes 4-6.
    const out = clusterByTag(
      [
        note(1, ["build", "docker"]),
        note(2, ["build", "docker"]),
        note(3, ["build", "docker"]),
        note(4, ["build"]),
        note(5, ["build"]),
        note(6, ["build"]),
      ],
      3,
      5,
    );
    expect(out).toEqual([
      { members: [1, 2, 3], sharedTags: ["docker"] },
      { members: [4, 5, 6], sharedTags: ["build"] },
    ]);
  });

  it("caps one group at TAG_CLUSTER_MAX_MEMBERS, oldest ids first", () => {
    const entries: MemoryEntry[] = [];
    for (let id = 40; id >= 1; id -= 1) entries.push(note(id, ["general"]));
    const out = clusterByTag(entries, 3, 5);
    expect(out).toHaveLength(1);
    expect(out[0]!.members).toHaveLength(TAG_CLUSTER_MAX_MEMBERS);
    expect(out[0]!.members[0]).toBe(1);
    expect(out[0]!.members.at(-1)).toBe(TAG_CLUSTER_MAX_MEMBERS);
  });

  it("stops at maxClusters", () => {
    const out = clusterByTag(
      [
        note(1, ["a"]), note(2, ["a"]), note(3, ["a"]),
        note(4, ["b"]), note(5, ["b"]), note(6, ["b"]),
      ],
      3,
      1,
    );
    expect(out).toEqual([{ members: [1, 2, 3], sharedTags: ["a"] }]);
  });
});
