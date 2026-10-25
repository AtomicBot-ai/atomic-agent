import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkEmbeddingMemory,
  claimLowMemoryEmbeddingNote,
  EMBEDDING_ALONE_MIN_TOTAL_RAM_BYTES,
  EMBEDDING_MIN_FREE_RAM_BYTES,
  EMBEDDING_MIN_TOTAL_RAM_BYTES,
  holdEmbeddingForLowMemory,
  resetLowMemoryEmbeddingNote,
} from "./embedding-memory-gate.js";

const GIB = 1024 ** 3;

describe("checkEmbeddingMemory (ATO-379)", () => {
  it("holds the memory model back below 7 GiB of total RAM, on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(checkEmbeddingMemory({ platform, totalBytes: 4 * GIB, freeBytes: 3 * GIB })).toMatchObject({ ok: false, reason: "total-ram" });
    }
  });

  it("keeps it on an 8 GB machine that reports a little less after the GPU's share", () => {
    expect(checkEmbeddingMemory({ platform: "win32", totalBytes: 7.6 * GIB, freeBytes: 3 * GIB })).toEqual({ ok: true });
    expect(checkEmbeddingMemory({ platform: "darwin", totalBytes: 8 * GIB, freeBytes: 0.2 * GIB })).toEqual({ ok: true });
  });

  it("holds it back when free RAM is short on Linux and Windows", () => {
    expect(checkEmbeddingMemory({ platform: "linux", totalBytes: 16 * GIB, freeBytes: 1 * GIB })).toMatchObject({ ok: false, reason: "free-ram" });
    expect(checkEmbeddingMemory({ platform: "win32", totalBytes: 16 * GIB, freeBytes: 1 * GIB })).toMatchObject({ ok: false, reason: "free-ram" });
    expect(checkEmbeddingMemory({ platform: "linux", totalBytes: 16 * GIB, freeBytes: 2 * GIB })).toEqual({ ok: true });
  });

  it("ignores macOS free RAM, which leaves out the memory the system gives back on demand", () => {
    expect(checkEmbeddingMemory({ platform: "darwin", totalBytes: 16 * GIB, freeBytes: 0.3 * GIB })).toEqual({ ok: true });
  });

  it("with no local chat model running, applies only the 4 GiB floor and no free-RAM rule", () => {
    const alone = { localChatRunning: false };
    expect(checkEmbeddingMemory({ platform: "linux", totalBytes: 6 * GIB, freeBytes: 0.5 * GIB }, alone)).toEqual({ ok: true });
    expect(checkEmbeddingMemory({ platform: "win32", totalBytes: 3.5 * GIB, freeBytes: 2 * GIB }, alone)).toMatchObject({ ok: false, reason: "total-ram" });
    // The same 6 GiB machine with a chat model beside it is held back.
    expect(checkEmbeddingMemory({ platform: "linux", totalBytes: 6 * GIB, freeBytes: 0.5 * GIB })).toMatchObject({ ok: false, reason: "total-ram" });
  });

  it("never blocks on an unreadable figure", () => {
    expect(checkEmbeddingMemory({ platform: "linux", totalBytes: 0, freeBytes: 0 })).toEqual({ ok: true });
  });

  it("keeps its lines where the comment puts them", () => {
    expect(EMBEDDING_MIN_TOTAL_RAM_BYTES).toBe(7 * GIB);
    expect(EMBEDDING_MIN_FREE_RAM_BYTES).toBe(1.5 * GIB);
    expect(EMBEDDING_ALONE_MIN_TOTAL_RAM_BYTES).toBe(4 * GIB);
  });
});

describe("holdEmbeddingForLowMemory", () => {
  it("turns off a Core module left enabled when memory is short, so no embed request loads it", async () => {
    const turnOffCoreModule = vi.fn(async () => true);
    const verdict = await holdEmbeddingForLowMemory("/data", {
      check: () => ({ ok: false, reason: "total-ram", totalBytes: 4 * GIB, freeBytes: GIB }),
      turnOffCoreModule,
    });
    expect(verdict.ok).toBe(false);
    expect(turnOffCoreModule).toHaveBeenCalledWith("/data");
  });

  it("touches nothing when there is room, and survives a turn-off that fails", async () => {
    const turnOffCoreModule = vi.fn(async () => { throw new Error("Core did not answer"); });
    await expect(holdEmbeddingForLowMemory("/data", { check: () => ({ ok: true }), turnOffCoreModule })).resolves.toEqual({ ok: true });
    expect(turnOffCoreModule).not.toHaveBeenCalled();
    await expect(holdEmbeddingForLowMemory("/data", {
      check: () => ({ ok: false, reason: "free-ram", totalBytes: 16 * GIB, freeBytes: GIB }),
      turnOffCoreModule,
    })).resolves.toMatchObject({ ok: false });
  });
});

describe("claimLowMemoryEmbeddingNote", () => {
  afterEach(() => resetLowMemoryEmbeddingNote());

  it("is claimed once per process", () => {
    expect(claimLowMemoryEmbeddingNote()).toBe(true);
    expect(claimLowMemoryEmbeddingNote()).toBe(false);
    expect(claimLowMemoryEmbeddingNote()).toBe(false);
  });
});
