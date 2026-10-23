import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../local-llm/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../local-llm/index.js")
  >("../../local-llm/index.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(),
    isEmbeddingModelDownloaded: vi.fn(),
  };
});

import { getConfig, resetConfigCache } from "../../config/index.js";
import * as localLlm from "../../local-llm/index.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

type Internals = {
  daemonSupervised: boolean;
  embeddingKeptForCloud: boolean;
  supervisor: { stop(): void };
};

/**
 * ATO-376: picking a cloud chat model stops only the local chat daemon.
 * The embedding daemon, and with it meaning-based memory search, stays
 * up; `memory.embeddings.enabled` is not written. With nothing worth
 * keeping, or a chat start still in flight, the full stop runs as before.
 */
describe("LocalModelsOrchestrator.stopChatForCloudSelection", () => {
  let stateDir: string;
  const built: Internals[] = [];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-cloud-stop-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { modelId: "qwen-3.5-4b" },
      embeddings: { enabled: true, modelId: "nomic-embed-text-v1.5" },
    });
    vi.mocked(localLlm.getDaemonStatus).mockReset().mockResolvedValue({
      running: true, healthy: true, loading: false, pid: 1234, port: 19091,
    });
    vi.mocked(localLlm.isEmbeddingModelDownloaded).mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    for (const inner of built.splice(0)) inner.supervisor.stop();
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function build() {
    const orchestrator = new LocalModelsOrchestrator({
      emit() {},
      subscribe: () => () => {},
    });
    const chatOnly = vi.spyOn(orchestrator, "stopChatDaemonOnly").mockResolvedValue(true);
    const full = vi.spyOn(orchestrator, "stopDaemon").mockResolvedValue();
    const inner = orchestrator as unknown as Internals;
    built.push(inner);
    return { orchestrator, inner, chatOnly, full };
  }

  it("stops only the chat daemon and keeps the memory search flag", async () => {
    const before = getConfig().memory.embeddings.enabled;
    const { orchestrator, inner, chatOnly, full } = build();
    inner.daemonSupervised = true;
    await orchestrator.stopChatForCloudSelection();
    expect(chatOnly).toHaveBeenCalledTimes(1);
    expect(chatOnly.mock.calls[0]![0]?.stoppedLine).toBe(
      "local-llm: chat server stopped, memory search stays on",
    );
    expect(full).not.toHaveBeenCalled();
    expect(getConfig().memory.embeddings.enabled).toBe(before);
    // The supervisor must not bring the chat daemon back on the cloud
    // route, but the kept embedding daemon is still torn down at exit.
    expect(inner.daemonSupervised).toBe(false);
    expect(inner.embeddingKeptForCloud).toBe(true);
  });

  it("falls back to the full stop when the embedding model is not downloaded", async () => {
    vi.mocked(localLlm.isEmbeddingModelDownloaded).mockReturnValue(false);
    const { orchestrator, chatOnly, full } = build();
    await orchestrator.stopChatForCloudSelection();
    expect(full).toHaveBeenCalledTimes(1);
    expect(chatOnly).not.toHaveBeenCalled();
  });

  it("falls back to the full stop when embeddings are switched off", async () => {
    persistUserLocalModelsConfig({ embeddings: { enabled: false } });
    const { orchestrator, chatOnly, full } = build();
    await orchestrator.stopChatForCloudSelection();
    expect(full).toHaveBeenCalledTimes(1);
    expect(chatOnly).not.toHaveBeenCalled();
  });

  it("falls back to the full stop while the chat daemon is still starting", async () => {
    vi.mocked(localLlm.getDaemonStatus).mockResolvedValue({
      running: false, healthy: false, loading: false, pid: null, port: 19091,
    });
    const { orchestrator, chatOnly, full } = build();
    await orchestrator.stopChatForCloudSelection();
    expect(full).toHaveBeenCalledTimes(1);
    expect(chatOnly).not.toHaveBeenCalled();
  });

  it("keeps ownership when the chat stop failed", async () => {
    const { orchestrator, inner, chatOnly } = build();
    chatOnly.mockResolvedValue(false);
    inner.daemonSupervised = true;
    await orchestrator.stopChatForCloudSelection();
    expect(inner.daemonSupervised).toBe(true);
    expect(inner.embeddingKeptForCloud).toBe(false);
  });
});
