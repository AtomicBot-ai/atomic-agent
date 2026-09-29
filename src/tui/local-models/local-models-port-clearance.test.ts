import { describe, expect, it, vi } from "vitest";

import type { getConfig } from "../../config/index.js";
import type { ReclaimOutcome, ReclaimRequest } from "../../local-llm/index.js";
import { clearChatPort, clearEmbeddingPort } from "./local-models-port-clearance.js";

const cfg = {
  paths: { localModelsDataDir: "/state/models" },
  localModels: {
    managed: { port: 19091 },
    embeddings: { port: 19092 },
  },
} as unknown as ReturnType<typeof getConfig>;

function harness(outcome: ReclaimOutcome) {
  const lines: string[] = [];
  const requests: ReclaimRequest[] = [];
  const persist = vi.fn();
  const onChatPortMoved = vi.fn();
  return {
    lines,
    requests,
    persist,
    onChatPortMoved,
    deps: {
      say: (l: string) => lines.push(l),
      reclaim: async (r: ReclaimRequest) => {
        requests.push(r);
        return outcome;
      },
      persist,
      onChatPortMoved,
    },
  };
}

describe("clearChatPort", () => {
  it("a free port: starts where configured, says nothing, writes nothing", async () => {
    const h = harness({ kind: "free" });
    expect(await clearChatPort(cfg, "qwen-3.5-4b", h.deps)).toEqual({ port: 19091, adoptedPid: null });
    expect(h.requests).toEqual([
      { port: 19091, role: "chat", ownDataDir: "/state/models", alias: "qwen-3.5-4b", avoidPorts: [19092] },
    ]);
    expect(h.lines).toEqual([]);
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("a move is saved to config and the live route is re-pointed", async () => {
    const h = harness({ kind: "moved", port: 19093, why: "port 19091 is held by pid 1 (x)" });
    expect(await clearChatPort(cfg, "qwen-3.5-4b", h.deps)).toEqual({ port: 19093, adoptedPid: null });
    expect(h.persist).toHaveBeenCalledWith({ managed: { port: 19093 } });
    expect(h.onChatPortMoved).toHaveBeenCalledWith("http://127.0.0.1:19093");
    expect(h.lines).toEqual([
      "local-llm: chat server on port 19093 (saved to config) — port 19091 is held by pid 1 (x)",
    ]);
  });

  it("an adoption hands back the pid and starts nothing", async () => {
    const h = harness({ kind: "adopted", pid: 61655 });
    expect(await clearChatPort(cfg, "qwen-3.5-4b", h.deps)).toEqual({ port: 19091, adoptedPid: 61655 });
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("a stop reports itself and keeps the configured port", async () => {
    const h = harness({ kind: "stopped", pid: 46051, why: "stopped a leftover llama-server pid 46051 (y)" });
    expect(await clearChatPort(cfg, "qwen-3.5-4b", h.deps)).toEqual({ port: 19091, adoptedPid: null });
    expect(h.lines).toEqual(["local-llm: chat server — stopped a leftover llama-server pid 46051 (y)"]);
  });
});

describe("clearEmbeddingPort", () => {
  const requested = { dataDir: "/state/models", modelId: "nomic-embed-text-v1.5", port: 19092 } as const;

  it("nothing requested, nothing asked", async () => {
    const h = harness({ kind: "free" });
    expect(await clearEmbeddingPort(cfg, undefined, 19091, h.deps)).toEqual({ options: undefined, adoptedPid: null });
    expect(h.requests).toEqual([]);
  });

  it("a move starts on the new port, persists it, and avoids the chat port", async () => {
    const h = harness({ kind: "moved", port: 19094, why: "held" });
    const out = await clearEmbeddingPort(cfg, requested, 19093, h.deps);
    expect(out).toEqual({ options: { ...requested, port: 19094 }, adoptedPid: null });
    expect(h.requests[0]).toMatchObject({ role: "embedding", avoidPorts: [19093], alias: "nomic-embed-text-v1.5" });
    expect(h.persist).toHaveBeenCalledWith({ embeddings: { port: 19094 } });
    expect(h.onChatPortMoved).not.toHaveBeenCalled();
  });

  it("an adoption starts nothing", async () => {
    const h = harness({ kind: "adopted", pid: 7 });
    expect(await clearEmbeddingPort(cfg, requested, 19091, h.deps)).toEqual({ options: undefined, adoptedPid: 7 });
  });
});
