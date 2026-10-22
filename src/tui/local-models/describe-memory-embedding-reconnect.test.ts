import { describe, expect, it } from "vitest";

import { describeMemoryEmbeddingReconnect } from "./describe-memory-embedding-reconnect.js";

describe("describeMemoryEmbeddingReconnect", () => {
  it("says nothing when memory already used that model", () => {
    expect(describeMemoryEmbeddingReconnect({ health: "ok", modelId: "bge-m3", changed: false })).toBeNull();
  });

  it("names the new model and the background re-embed", () => {
    expect(describeMemoryEmbeddingReconnect({ health: "ok", modelId: "bge-m3", changed: true })).toBe(
      "memory: now using bge-m3 for recall; older notes are re-embedded in the background",
    );
  });

  it("says recall falls back to keywords when the model does not answer or is off", () => {
    expect(
      describeMemoryEmbeddingReconnect({ health: "unreachable", modelId: "bge-m3", why: "daemon down", changed: true }),
    ).toBe("memory: bge-m3 is not answering (daemon down); recall uses keywords until it does");
    expect(describeMemoryEmbeddingReconnect({ health: "disabled", modelId: null, changed: true })).toBe(
      "memory: embeddings off, recall uses keywords only",
    );
  });

  it("uses no em dash", () => {
    for (const health of ["ok", "unreachable", "disabled"] as const) {
      expect(describeMemoryEmbeddingReconnect({ health, modelId: "m", why: "x", changed: true })).not.toContain("\u2014");
    }
  });
});
