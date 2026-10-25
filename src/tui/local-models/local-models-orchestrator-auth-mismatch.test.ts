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
    getEmbeddingDaemonStatus: vi.fn(),
  };
});

import { resetConfigCache } from "../../config/index.js";
import * as localLlm from "../../local-llm/index.js";
import type {
  EmbeddingDaemonInfo,
  LocalModelsDaemonInfo,
} from "./local-models-panel-state.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

type Snapshot = {
  type: "local_models_snapshot_loaded";
  daemon: LocalModelsDaemonInfo;
  embeddingDaemon: EmbeddingDaemonInfo;
};

/**
 * ATO-852: `getDaemonStatus` reports `authMismatch` when a server answers
 * `/health` on the session's port but rejects the session's key. The
 * panel can only say "key rejected" if the snapshot carries the flag.
 */
describe("LocalModelsOrchestrator snapshot: rejected key", () => {
  let stateDir: string;
  let previousFetch: typeof fetch;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-auth-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    previousFetch = globalThis.fetch;
    // The backend-release probe is the only network in refresh().
    globalThis.fetch = (() =>
      Promise.reject(new Error("offline"))) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  async function snapshot(): Promise<Snapshot | undefined> {
    const actions: { type: string }[] = [];
    const orchestrator = new LocalModelsOrchestrator({
      emit(action: unknown) {
        actions.push(action as { type: string });
      },
      subscribe: () => () => {},
    });
    await orchestrator.refresh();
    return actions.find(
      (a): a is Snapshot => a.type === "local_models_snapshot_loaded",
    );
  }

  it("passes authMismatch through for the chat and embedding daemons", async () => {
    vi.mocked(localLlm.getDaemonStatus).mockResolvedValue({
      running: true,
      healthy: false,
      loading: false,
      authMismatch: true,
      pid: 4321,
      port: 19091,
    });
    vi.mocked(localLlm.getEmbeddingDaemonStatus).mockResolvedValue({
      running: true,
      healthy: false,
      loading: false,
      authMismatch: true,
      pid: 4322,
      port: 19092,
    });
    const snap = await snapshot();
    expect(snap?.daemon).toMatchObject({ running: true, healthy: false, authMismatch: true });
    expect(snap?.embeddingDaemon).toMatchObject({ running: true, authMismatch: true });
  });

  it("leaves the flag off a daemon whose key is accepted", async () => {
    vi.mocked(localLlm.getDaemonStatus).mockResolvedValue({
      running: true,
      healthy: true,
      loading: false,
      pid: 4321,
      port: 19091,
    });
    vi.mocked(localLlm.getEmbeddingDaemonStatus).mockResolvedValue({
      running: false,
      healthy: false,
      loading: false,
      pid: null,
      port: 19092,
    });
    const snap = await snapshot();
    expect(snap?.daemon.authMismatch).toBeUndefined();
    expect(snap?.embeddingDaemon.authMismatch).toBeUndefined();
  });
});
