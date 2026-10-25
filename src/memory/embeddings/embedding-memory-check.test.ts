import { describe, expect, it } from "vitest";

import {
  assessEmbeddingMemory,
  checkEmbeddingModelMemory,
  EMBEDDING_MIN_AVAILABLE_RAM_BYTES,
  EMBEDDING_MIN_TOTAL_RAM_BYTES,
  lowMemoryEmbeddingNote,
  parseVmStatAvailableBytes,
  readSystemMemory,
} from "./embedding-memory-check.js";

const GIB = 1024 * 1024 * 1024;
const GEMMA_GB = 0.31; // EmbeddingGemma 2's file size in the catalog

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                3000.
Pages active:                            200000.
Pages inactive:                           40000.
Pages speculative:                         2000.
Pages throttled:                              0.
Pages wired down:                         90000.
Pages purgeable:                           5000.
"Translation faults":                 123456789.
`;

describe("parseVmStatAvailableBytes", () => {
  it("counts free, inactive and speculative pages at the reported page size", () => {
    expect(parseVmStatAvailableBytes(VM_STAT)).toBe((3000 + 40000 + 2000) * 16384);
  });
  it("is null for output it cannot read", () => {
    expect(parseVmStatAvailableBytes("")).toBeNull();
    expect(parseVmStatAvailableBytes("Pages free: 12.")).toBeNull();
  });
});

describe("readSystemMemory", () => {
  it("asks vm_stat on macOS, where os.freemem leaves out the file cache", async () => {
    const memory = await readSystemMemory({
      platform: "darwin",
      vmStat: async () => VM_STAT,
      freeBytes: () => 1,
      totalBytes: () => 16 * GIB,
    });
    expect(memory).toEqual({ totalBytes: 16 * GIB, availableBytes: 45000 * 16384 });
  });
  it("on macOS without vm_stat, looks at total RAM only rather than trust the free-page count", async () => {
    const memory = await readSystemMemory({
      platform: "darwin",
      vmStat: async () => null,
      freeBytes: () => 1,
      totalBytes: () => 16 * GIB,
    });
    expect(memory).toEqual({ totalBytes: 16 * GIB, availableBytes: null });
  });
  it("uses os.freemem elsewhere (MemAvailable on Linux)", async () => {
    const memory = await readSystemMemory({
      platform: "linux",
      vmStat: async () => { throw new Error("not called"); },
      freeBytes: () => 3 * GIB,
      totalBytes: () => 8 * GIB,
    });
    expect(memory).toEqual({ totalBytes: 8 * GIB, availableBytes: 3 * GIB });
  });
});

describe("assessEmbeddingMemory", () => {
  it("says the operator's note when the machine has under 8 GB in total", () => {
    const check = assessEmbeddingMemory({ totalBytes: 4 * GIB, availableBytes: 3 * GIB }, GEMMA_GB);
    expect(check).toMatchObject({ ok: false, reason: "total" });
    expect(check.ok === false && check.note).toBe(
      "Memory search uses keywords: not enough free memory for the memory model (needs ~300 MB).",
    );
  });
  it("keeps an 8 GB machine, which reports a little under 8 GiB", () => {
    expect(assessEmbeddingMemory({ totalBytes: 7.8 * GIB, availableBytes: 2 * GIB }, GEMMA_GB)).toEqual({ ok: true });
    expect(EMBEDDING_MIN_TOTAL_RAM_BYTES).toBeLessThan(7.8 * GIB);
  });
  it("skips when less than about 1 GB is available", () => {
    expect(assessEmbeddingMemory({ totalBytes: 16 * GIB, availableBytes: 0.5 * GIB }, GEMMA_GB))
      .toMatchObject({ ok: false, reason: "available" });
    expect(assessEmbeddingMemory({ totalBytes: 16 * GIB, availableBytes: EMBEDDING_MIN_AVAILABLE_RAM_BYTES }, GEMMA_GB))
      .toEqual({ ok: true });
  });
  it("asks twice the file size of a larger model", () => {
    // BGE-M3: 0.635 GB file, 1.27 GB needed.
    expect(assessEmbeddingMemory({ totalBytes: 16 * GIB, availableBytes: 1.1 * GIB }, 0.635))
      .toMatchObject({ ok: false, reason: "available" });
    expect(lowMemoryEmbeddingNote(0.635)).toContain("(needs ~600 MB)");
  });
  it("judges on total RAM alone when available memory is unknown", () => {
    expect(assessEmbeddingMemory({ totalBytes: 16 * GIB, availableBytes: null }, GEMMA_GB)).toEqual({ ok: true });
  });
});

describe("checkEmbeddingModelMemory", () => {
  it("says ok when the probe fails, so a broken probe never costs the model", async () => {
    await expect(checkEmbeddingModelMemory(GEMMA_GB, async () => { throw new Error("boom"); })).resolves.toEqual({ ok: true });
  });
  it("assesses what the probe reads", async () => {
    await expect(checkEmbeddingModelMemory(GEMMA_GB, async () => ({ totalBytes: 16 * GIB, availableBytes: 0.2 * GIB })))
      .resolves.toMatchObject({ ok: false, reason: "available" });
  });
});
