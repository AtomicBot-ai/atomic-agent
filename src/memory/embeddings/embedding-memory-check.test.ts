import { describe, expect, it } from "vitest";

import {
  assessEmbeddingMemory,
  CHAT_MODEL_LOAD_HEADROOM_BYTES,
  chatModelReserveBytes,
  checkEmbeddingModelMemory,
  EMBEDDING_MIN_AVAILABLE_RAM_BYTES,
  EMBEDDING_MIN_TOTAL_RAM_BYTES,
  embeddingAvailableNeedBytes,
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
  it("names the machine's RAM and the floor when there is too little in total", () => {
    const check = assessEmbeddingMemory({ totalBytes: 4 * GIB, availableBytes: 3 * GIB }, GEMMA_GB);
    expect(check).toMatchObject({ ok: false, reason: "total" });
    expect(check.ok === false && check.note).toBe(
      "Memory search uses keywords: this machine has 4 GB of memory; the memory model needs at least 6 GB.",
    );
  });
  it("keeps an 8 GB laptop that reserves memory for integrated graphics (6-7 GiB reported)", () => {
    expect(EMBEDDING_MIN_TOTAL_RAM_BYTES).toBe(6 * GIB);
    expect(assessEmbeddingMemory({ totalBytes: 6.5 * GIB, availableBytes: 2 * GIB }, GEMMA_GB)).toEqual({ ok: true });
    expect(assessEmbeddingMemory({ totalBytes: 5.9 * GIB, availableBytes: 2 * GIB }, GEMMA_GB)).toMatchObject({ reason: "total" });
  });
  it("skips under about 1 GB available, and the note says the threshold it applied", () => {
    const check = assessEmbeddingMemory({ totalBytes: 16 * GIB, availableBytes: 0.5 * GIB }, GEMMA_GB);
    expect(check).toMatchObject({ ok: false, reason: "available" });
    expect(check.ok === false && check.note).toBe(
      "Memory search uses keywords: not enough free memory for the memory model (needs ~1 GB free).",
    );
    expect(assessEmbeddingMemory({ totalBytes: 16 * GIB, availableBytes: EMBEDDING_MIN_AVAILABLE_RAM_BYTES }, GEMMA_GB))
      .toEqual({ ok: true });
  });
  it("asks twice the file size of a larger model, and says so", () => {
    // BGE-M3: 0.635 GB file, 1.27 GB (1.2 GiB) needed.
    expect(embeddingAvailableNeedBytes(0.635)).toBeCloseTo(1.27e9, 0);
    const check = assessEmbeddingMemory({ totalBytes: 16 * GIB, availableBytes: 1.1 * GIB }, 0.635);
    expect(check.ok === false && check.note).toContain("(needs ~1.2 GB free)");
  });
  it("judges on total RAM alone when available memory is unknown", () => {
    expect(assessEmbeddingMemory({ totalBytes: 16 * GIB, availableBytes: null }, GEMMA_GB)).toEqual({ ok: true });
  });
  it("counts what a chat model starting in the same launch is about to take", () => {
    // 3 GB free looks enough on its own; a 4.2 GB chat model loading beside it takes all of it.
    const memory = { totalBytes: 16 * GIB, availableBytes: 3e9 };
    expect(assessEmbeddingMemory(memory, GEMMA_GB)).toEqual({ ok: true });
    const check = assessEmbeddingMemory(memory, GEMMA_GB, chatModelReserveBytes(4.2));
    expect(check).toMatchObject({ ok: false, reason: "available" });
    expect(check.ok === false && check.note).toBe(
      "Memory search uses keywords: not enough free memory for the memory model beside the chat model (needs ~1 GB free).",
    );
    expect(chatModelReserveBytes(4.2)).toBeCloseTo(4.2e9 + CHAT_MODEL_LOAD_HEADROOM_BYTES, 0);
  });
});

describe("checkEmbeddingModelMemory", () => {
  it("says ok when the probe fails, so a broken probe never costs the model", async () => {
    await expect(checkEmbeddingModelMemory(GEMMA_GB, { read: async () => { throw new Error("boom"); } })).resolves.toEqual({ ok: true });
  });
  it("assesses what the probe reads", async () => {
    await expect(checkEmbeddingModelMemory(GEMMA_GB, { read: async () => ({ totalBytes: 16 * GIB, availableBytes: 0.2 * GIB }) }))
      .resolves.toMatchObject({ ok: false, reason: "available" });
  });
  it("subtracts the chat model starting with it: 3 GB available, 4.2 GB chat model, not started", async () => {
    const read = async () => ({ totalBytes: 16 * GIB, availableBytes: 3e9 });
    await expect(checkEmbeddingModelMemory(GEMMA_GB, { read })).resolves.toEqual({ ok: true });
    await expect(checkEmbeddingModelMemory(GEMMA_GB, { read, chatModelGb: 4.2 })).resolves.toMatchObject({ ok: false, reason: "available" });
  });
});
