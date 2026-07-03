import { describe, expect, it, vi } from "vitest";

import { RuntimeApiError } from "./runtime-api-error.js";
import {
  expandLinks,
  getNote,
  listNotes,
  listProfile,
  listVotes,
  profileHistory,
  recallNotes,
  type MemoryServiceDeps,
} from "./memory-service.js";

function makeDeps(overrides: Partial<MemoryServiceDeps> = {}): MemoryServiceDeps {
  return {
    profileStore: {
      list: vi.fn(() => [{ id: 1, key: "name", value: "Alex" }] as never),
      history: vi.fn(() => [{ id: 1, key: "name", value: "Alex" }] as never),
    },
    notesStore: {
      recallHybridAsync: vi.fn(async () => [{ id: 7, content: "note" }] as never),
      list: vi.fn(() => [{ id: 7, content: "note" }] as never),
      get: vi.fn(() => ({ id: 7, content: "note", tags: [] }) as never),
      getConsolidatedInto: vi.fn(() => null),
    },
    lessonStore: {
      listIndex: vi.fn(() => [] as never),
      getById: vi.fn(() => null),
    },
    procedureStore: {
      listIndex: vi.fn(() => [] as never),
      getById: vi.fn(() => null),
    },
    linkStore: {
      listAll: vi.fn(() => [] as never),
      expand: vi.fn(() => [8, 9]),
    },
    voteStore: {
      listEvents: vi.fn(() => [{ id: 1, kind: "memory", targetId: 7 }] as never),
    },
    ...overrides,
  };
}

describe("memory-service facade", () => {
  it("lists profile facts", () => {
    const deps = makeDeps();
    expect(listProfile(deps)).toHaveLength(1);
  });

  it("rejects an empty profile history key", () => {
    const deps = makeDeps();
    expect(() => profileHistory(deps, "")).toThrow(RuntimeApiError);
  });

  it("recalls notes via the hybrid path", async () => {
    const deps = makeDeps();
    const notes = await recallNotes(deps, { query: "hi" });
    expect(notes).toHaveLength(1);
    expect(deps.notesStore.recallHybridAsync).toHaveBeenCalledWith("hi", {});
  });

  it("threads scope + workingDir into hybrid recall", async () => {
    const deps = makeDeps();
    await recallNotes(deps, {
      query: "hi",
      k: 5,
      scope: "project",
      workingDir: "/tmp",
    });
    expect(deps.notesStore.recallHybridAsync).toHaveBeenCalledWith("hi", {
      k: 5,
      scope: "project",
      workingDir: "/tmp",
    });
  });

  it("lists notes excluding archived by default", () => {
    const deps = makeDeps();
    listNotes(deps, {});
    expect(deps.notesStore.list).toHaveBeenCalledWith({
      limit: 200,
      excludeArchived: true,
    });
  });

  it("returns a null note without touching the consolidation pointer", () => {
    const deps = makeDeps({
      notesStore: {
        recallHybridAsync: vi.fn(async () => [] as never),
        list: vi.fn(() => [] as never),
        get: vi.fn(() => null),
        getConsolidatedInto: vi.fn(() => 42),
      },
    });
    const result = getNote(deps, 99);
    expect(result.note).toBeNull();
    expect(result.consolidatedInto).toBeNull();
    expect(deps.notesStore.getConsolidatedInto).not.toHaveBeenCalled();
  });

  it("pairs a note with its consolidation pointer", () => {
    const deps = makeDeps();
    const result = getNote(deps, 7);
    expect(result.note?.id).toBe(7);
    expect(result.consolidatedInto).toBeNull();
  });

  it("rejects a non-positive note id", () => {
    const deps = makeDeps();
    expect(() => getNote(deps, 0)).toThrow(RuntimeApiError);
  });

  it("rejects an empty seed set on links expand", () => {
    const deps = makeDeps();
    expect(() => expandLinks(deps, { seedIds: [] })).toThrow(RuntimeApiError);
  });

  it("expands links from a seed set", () => {
    const deps = makeDeps();
    expect(expandLinks(deps, { seedIds: [7], depth: 2 })).toEqual([8, 9]);
    expect(deps.linkStore.expand).toHaveBeenCalledWith([7], { depth: 2 });
  });

  it("throws subsystem_disabled when the vote store is null", () => {
    const deps = makeDeps({ voteStore: null });
    expect(() => listVotes(deps, {})).toThrow(RuntimeApiError);
  });
});
