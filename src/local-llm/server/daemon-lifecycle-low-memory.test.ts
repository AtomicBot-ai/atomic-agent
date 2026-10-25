import { describe, expect, it, vi } from "vitest";

import { startChatAndEmbeddingDaemons, type DaemonStartResult } from "./daemon-lifecycle.js";

/**
 * ATO-379: the paired start asks the memory gate after the chat model is
 * up, and on a machine with little memory leaves the embedding model off
 * while the chat model keeps running.
 */
describe("startChatAndEmbeddingDaemons on a machine with little memory", () => {
  const chat = { pid: 101, tokensPerSecond: null, contextSize: 4096 } as unknown as DaemonStartResult;
  const opts = {
    chat: { dataDir: "/data", modelId: "qwen-3.5-4b" as never, port: 19091 },
    embedding: { dataDir: "/data", modelId: "embeddinggemma-2" as never, port: 19092 },
  };

  it("starts the chat model, skips the embedding model and says why", async () => {
    const order: string[] = [];
    const startChat = vi.fn(async () => { order.push("chat"); return chat; });
    const startEmbedding = vi.fn(async () => ({ pid: 202 }));
    const holdForLowMemory = vi.fn(async () => {
      order.push("gate");
      return { ok: false as const, reason: "total-ram" as const, totalBytes: 4 * 1024 ** 3, freeBytes: 1024 ** 3 };
    });

    const result = await startChatAndEmbeddingDaemons(opts, { startChat, startEmbedding, holdForLowMemory });

    expect(result).toEqual({ chat, embedding: { skipped: true, lowMemory: true } });
    expect(startEmbedding).not.toHaveBeenCalled();
    expect(holdForLowMemory).toHaveBeenCalledWith("/data");
    // Free memory is read once the chat model holds its share.
    expect(order).toEqual(["chat", "gate"]);
  });

  it("starts both as before when there is room", async () => {
    const startEmbedding = vi.fn(async () => ({ pid: 202 }));
    const result = await startChatAndEmbeddingDaemons(opts, {
      startChat: async () => chat,
      startEmbedding,
      holdForLowMemory: async () => ({ ok: true as const }),
    });

    expect(result).toEqual({ chat, embedding: { pid: 202 } });
    expect(startEmbedding).toHaveBeenCalledTimes(1);
  });

  it("does not ask the gate when no embedding model was requested", async () => {
    const holdForLowMemory = vi.fn(async () => ({ ok: true as const }));
    const result = await startChatAndEmbeddingDaemons({ chat: opts.chat }, { startChat: async () => chat, holdForLowMemory });

    expect(result.embedding).toEqual({ skipped: true });
    expect(holdForLowMemory).not.toHaveBeenCalled();
  });
});
