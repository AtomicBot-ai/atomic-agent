import { afterEach, describe, expect, it, vi } from "vitest";

import type { AtomicAgentConfig } from "../../config/config-schema.js";
import * as health from "../../llm/llama-server-health.js";
import type { EmbeddingMemoryCheck } from "./embedding-memory-check.js";
import { connectMemoryEmbeddings } from "./memory-embedding-connection.js";

type Config = Pick<AtomicAgentConfig, "paths" | "memory" | "localModels">;

const NOTE = "Memory search uses keywords: not enough free memory for the memory model (needs ~300 MB).";
const low: EmbeddingMemoryCheck = { ok: false, reason: "available", note: NOTE, detail: "0.4 GB available, needs 1.0 GB" };

function config(modelId: string, enabled = true): Config {
  return {
    paths: { localModelsDataDir: "/data" },
    memory: { embeddings: { enabled } },
    localModels: { embeddings: { enabled, modelId, url: "http://127.0.0.1:1" } },
  } as unknown as Config;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** ATO-379: a machine short of memory does not start the memory model. */
describe("connectMemoryEmbeddings on a machine short of memory", () => {
  it("keeps memory on keywords, with the note, instead of attaching an idle Core module", async () => {
    const checkMemory = vi.fn(async (_fileSizeGb: number) => low);
    const connection = await connectMemoryEmbeddings(config("embeddinggemma-2"), {
      probeCore: async () => ({ reachable: true, loaded: false }),
      checkMemory,
    });
    expect(connection).toEqual({ state: "unreachable", modelId: "embeddinggemma-2", why: NOTE, lowMemory: true });
    // The catalog's file size decides what the model needs.
    expect(checkMemory).toHaveBeenCalledWith(0.31);
  });

  it("attaches an idle Core module as before when there is enough memory", async () => {
    const connection = await connectMemoryEmbeddings(config("embeddinggemma-2"), {
      probeCore: async () => ({ reachable: true, loaded: false }),
      checkMemory: async () => ({ ok: true }),
    });
    expect(connection).toMatchObject({ state: "reachable", modelId: "embeddinggemma-2" });
  });

  it("does not check a module that is already loaded: its memory is spent", async () => {
    const checkMemory = vi.fn(async (_fileSizeGb: number) => low);
    const connection = await connectMemoryEmbeddings(config("embeddinggemma-2"), {
      probeCore: async () => ({ reachable: true, loaded: true }),
      checkMemory,
    });
    expect(connection.state).toBe("reachable");
    expect(checkMemory).not.toHaveBeenCalled();
  });

  it("does not check a model served at its own URL: connecting starts nothing", async () => {
    vi.spyOn(health, "checkLlamaServer").mockResolvedValue({ reachable: true, status: 200, kind: "llama-server", error: null, latencyMs: 1 });
    const checkMemory = vi.fn(async (_fileSizeGb: number) => low);
    const connection = await connectMemoryEmbeddings(config("nomic-embed-text-v1.5"), { checkMemory });
    expect(connection.state).toBe("reachable");
    expect(checkMemory).not.toHaveBeenCalled();
  });

  it("does not check when embeddings are off", async () => {
    const checkMemory = vi.fn(async (_fileSizeGb: number) => low);
    await expect(connectMemoryEmbeddings(config("embeddinggemma-2", false), { checkMemory })).resolves.toEqual({ state: "disabled" });
    expect(checkMemory).not.toHaveBeenCalled();
  });
});
