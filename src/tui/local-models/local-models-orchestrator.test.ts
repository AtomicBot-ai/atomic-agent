import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getConfig,
  resetConfigCache,
  USER_CONFIG_VERSION,
} from "../../config/index.js";
import {
  getEmbeddingModelDef,
  getLocalModelDef,
  resolveBackendDir,
  resolveModelFilePath,
  resolveServerBinPath,
} from "../../local-llm/index.js";
import { resolvePlatformAsset } from "../../local-llm/platform-assets.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

/**
 * Materialise a fake llama-server binary so `isBackendDownloaded()`
 * returns `true` in tests that only care about the model-download
 * branch of `pullModel`.
 */
function stubBackendInstalled(dataDir: string): void {
  const backendDir = resolveBackendDir(dataDir);
  mkdirSync(backendDir, { recursive: true });
  const { binaryName } = resolvePlatformAsset();
  writeFileSync(resolveServerBinPath(dataDir, binaryName), "");
}

type EmittedAction =
  | { type: string }
  | {
      type: "local_models_pull_started";
      pull: { modelId: string };
    }
  | {
      type: "local_models_snapshot_loaded";
      rows: { id: string; active: boolean }[];
    };

describe("LocalModelsOrchestrator", () => {
  let stateDir: string;
  let previousFetch: typeof fetch;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-orch-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    previousFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function writeUserConfig(overrides: Record<string, unknown>): void {
    writeFileSync(
      join(stateDir, "config.json"),
      JSON.stringify({ version: USER_CONFIG_VERSION, ...overrides }),
    );
    resetConfigCache();
  }

  function makeSupervisedOrchestrator(): {
    orchestrator: LocalModelsOrchestrator;
    stopped: () => number;
  } {
    const orchestrator = new LocalModelsOrchestrator({ emit() {} });
    (orchestrator as unknown as { daemonSupervised: boolean }).daemonSupervised =
      true;
    const spy = vi
      .spyOn(
        orchestrator as unknown as {
          stopDaemonSilent: () => Promise<void>;
        },
        "stopDaemonSilent",
      )
      .mockResolvedValue();
    return { orchestrator, stopped: () => spy.mock.calls.length };
  }

  describe("shutdown daemon teardown (stopOnExit)", () => {
    it("stops the supervised daemon by default (last session)", async () => {
      writeUserConfig({});
      const { orchestrator, stopped } = makeSupervisedOrchestrator();
      await orchestrator.shutdown();
      expect(stopped()).toBe(1);
    });

    it("leaves the daemon running when stopOnExit=false", async () => {
      writeUserConfig({ localModels: { managed: { stopOnExit: false } } });
      const { orchestrator, stopped } = makeSupervisedOrchestrator();
      await orchestrator.shutdown();
      expect(stopped()).toBe(0);
    });

    it("leaves the daemon running while another live session exists", async () => {
      writeUserConfig({});
      const dataDir = getConfig().paths.localModelsDataDir;
      const sessionsDir = join(dataDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      // `process.ppid` is a live pid that is not this process.
      writeFileSync(join(sessionsDir, String(process.ppid)), "");
      const { orchestrator, stopped } = makeSupervisedOrchestrator();
      await orchestrator.shutdown();
      expect(stopped()).toBe(0);
    });

    it("never stops a daemon it does not supervise", async () => {
      writeUserConfig({});
      const { orchestrator, stopped } = makeSupervisedOrchestrator();
      (orchestrator as unknown as { daemonSupervised: boolean }).daemonSupervised =
        false;
      await orchestrator.shutdown();
      expect(stopped()).toBe(0);
    });
  });

  it("cancels the previous model pull when another model is selected", async () => {
    const actions: EmittedAction[] = [];
    const bus = {
      emit(action: unknown) {
        actions.push(action as EmittedAction);
      },
    };
    const orchestrator = new LocalModelsOrchestrator(bus);
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();
    // Auto-start of the daemon after a successful pull is not relevant
    // to this cancel/race test and depends on a fake llama-server
    // binary that would take ~30s to fail /health — skip it entirely.
    vi.spyOn(orchestrator, "startDaemon").mockResolvedValue();
    stubBackendInstalled(getConfig().paths.localModelsDataDir);

    let fetchCount = 0;
    let releaseFirstBody: (() => void) | null = null;
    globalThis.fetch = vi.fn(async () => {
      if (fetchCount === 0) {
        fetchCount += 1;
        let chunkIndex = 0;
        const slowBody = new ReadableStream({
          async pull(controller) {
            if (chunkIndex === 0) {
              chunkIndex += 1;
              controller.enqueue(Buffer.from("a"));
              return;
            }
            if (chunkIndex === 1) {
              chunkIndex += 1;
              await new Promise<void>((resolve) => {
                releaseFirstBody = resolve;
              });
              controller.enqueue(Buffer.from("b"));
              controller.close();
              return;
            }
            controller.close();
          },
        });
        return new Response(slowBody, {
          status: 200,
          headers: { "content-length": "2" },
        });
      }

      fetchCount += 1;
      return new Response(Buffer.from("zz"), {
        status: 200,
        headers: { "content-length": "2" },
      });
    }) as typeof fetch;

    const firstPull = orchestrator.pullModel("qwen-3.5-4b");
    await waitFor(() => startedPulls(actions).length === 1);
    await waitFor(() => releaseFirstBody !== null);

    const secondPull = orchestrator.pullModel("qwen-3.5-9b");
    await waitFor(() => startedPulls(actions).length === 2);
    releaseFirstBody?.();

    await Promise.allSettled([firstPull, secondPull]);

    // qwen-3.5-9b is vision-capable in the current catalog, so its
    // pull emits a second `pull_started` for the mmproj phase after
    // the GGUF phase completes. The cancelled qwen-3.5-4b never
    // reaches its mmproj phase.
    expect(startedPulls(actions)).toEqual([
      "qwen-3.5-4b",
      "qwen-3.5-9b",
      "qwen-3.5-9b",
    ]);
    expect(actions.filter((action) => action.type === "local_models_pull_failed")).toHaveLength(0);
    expect(actions.filter((action) => action.type === "local_models_pull_finished")).toHaveLength(1);

    const dataDir = getConfig().paths.localModelsDataDir;
    const firstModel = getLocalModelDef("qwen-3.5-4b");
    const secondModel = getLocalModelDef("qwen-3.5-9b");
    const firstPath = resolveModelFilePath(dataDir, firstModel.id, firstModel.filename);
    const secondPath = resolveModelFilePath(dataDir, secondModel.id, secondModel.filename);

    expect(existsSync(firstPath)).toBe(false);
    expect(existsSync(`${firstPath}.tmp`)).toBe(false);
    expect(existsSync(secondPath)).toBe(true);
  });

  it("downloads a missing model when setActive selects it", async () => {
    const actions: EmittedAction[] = [];
    const bus = {
      emit(action: unknown) {
        actions.push(action as EmittedAction);
      },
    };
    const orchestrator = new LocalModelsOrchestrator(bus);
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();
    const startDaemon = vi.spyOn(orchestrator, "startDaemon").mockResolvedValue(true);
    stubBackendInstalled(getConfig().paths.localModelsDataDir);
    globalThis.fetch = vi.fn(async () =>
      new Response(Buffer.from("gguf"), {
        status: 200,
        headers: { "content-length": "4" },
      }),
    ) as typeof fetch;

    await orchestrator.setActive("qwen-3.5-4b");

    expect(startedPulls(actions)[0]).toBe("qwen-3.5-4b");
    expect(actions.some((action) => action.type === "local_models_pull_finished")).toBe(
      true,
    );
    expect(startDaemon).toHaveBeenCalledOnce();
    const dataDir = getConfig().paths.localModelsDataDir;
    const def = getLocalModelDef("qwen-3.5-4b");
    expect(existsSync(resolveModelFilePath(dataDir, def.id, def.filename))).toBe(
      true,
    );
  });

  it("keeps chat and embedding downloads running independently", async () => {
    const actions: EmittedAction[] = [];
    const bus = {
      emit(action: unknown) {
        actions.push(action as EmittedAction);
      },
    };
    const orchestrator = new LocalModelsOrchestrator(bus);
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();
    const startDaemon = vi.spyOn(orchestrator, "startDaemon").mockResolvedValue();
    const startEmbeddingPairing = vi
      .spyOn(orchestrator, "startEmbeddingPairing")
      .mockResolvedValue();
    stubBackendInstalled(getConfig().paths.localModelsDataDir);

    let fetchCount = 0;
    let releaseChatBody: (() => void) | null = null;
    globalThis.fetch = vi.fn(async () => {
      if (fetchCount === 0) {
        fetchCount += 1;
        let chunkIndex = 0;
        const slowBody = new ReadableStream({
          async pull(controller) {
            if (chunkIndex === 0) {
              chunkIndex += 1;
              controller.enqueue(Buffer.from("a"));
              return;
            }
            await new Promise<void>((resolve) => {
              releaseChatBody = resolve;
            });
            controller.enqueue(Buffer.from("b"));
            controller.close();
          },
        });
        return new Response(slowBody, {
          status: 200,
          headers: { "content-length": "2" },
        });
      }

      fetchCount += 1;
      return new Response(Buffer.from("ee"), {
        status: 200,
        headers: { "content-length": "2" },
      });
    }) as typeof fetch;

    const chatPull = orchestrator.pullModel("qwen-3.5-4b");
    await waitFor(() => startedPulls(actions).length === 1);
    await waitFor(() => releaseChatBody !== null);

    const embeddingPull = orchestrator.pullEmbeddingModel("nomic-embed-text-v1.5");
    await waitFor(() => startedPulls(actions).length === 2);
    releaseChatBody?.();

    await Promise.all([chatPull, embeddingPull]);

    expect(startedPulls(actions)).toEqual([
      "qwen-3.5-4b",
      "nomic-embed-text-v1.5",
      // Qwen 3.5 4B is vision-capable, so the chat pull continues
      // into its mmproj phase after the GGUF phase completes.
      "qwen-3.5-4b",
    ]);
    expect(startDaemon).toHaveBeenCalledTimes(2);
    expect(startEmbeddingPairing).not.toHaveBeenCalled();
    expect(actions.filter((action) => action.type === "local_models_pull_failed")).toHaveLength(0);
    expect(actions.filter((action) => action.type === "local_models_pull_finished")).toHaveLength(2);

    const dataDir = getConfig().paths.localModelsDataDir;
    const chatDef = getLocalModelDef("qwen-3.5-4b");
    const embeddingDef = getEmbeddingModelDef("nomic-embed-text-v1.5");
    expect(existsSync(resolveModelFilePath(dataDir, chatDef.id, chatDef.filename))).toBe(
      true,
    );
    expect(
      existsSync(resolveModelFilePath(dataDir, embeddingDef.id, embeddingDef.filename)),
    ).toBe(true);
  });

  describe("refresh model rows", () => {
    it("lists an operator-added Hugging Face model on the same snapshot, active", async () => {
      writeUserConfig({
        localModels: {
          mode: "managed",
          customModels: [
            {
              id: "custom-unsloth-qwen3-0.6b-gguf-qwen3-0.6b-ud-q4_k_xl",
              filename: "Qwen3-0.6B-UD-Q4_K_XL.gguf",
              huggingFaceUrl:
                "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-UD-Q4_K_XL.gguf",
            },
          ],
          managed: {
            modelId: "custom-unsloth-qwen3-0.6b-gguf-qwen3-0.6b-ud-q4_k_xl",
          },
        },
      });
      // The backend-release probe is the only network in refresh();
      // offline it resolves to "unknown", which is fine here.
      globalThis.fetch = (() =>
        Promise.reject(new Error("offline"))) as typeof fetch;
      const actions: EmittedAction[] = [];
      const orchestrator = new LocalModelsOrchestrator({
        emit(action: unknown) {
          actions.push(action as EmittedAction);
        },
      });
      await orchestrator.refresh();
      const snapshot = actions.find(
        (action): action is Extract<EmittedAction, { type: "local_models_snapshot_loaded" }> =>
          action.type === "local_models_snapshot_loaded",
      );
      const rows = snapshot?.rows ?? [];
      const custom = rows.find((row) => row.id.startsWith("custom-"));
      // The added model rides the snapshot the panel draws from, and the
      // active mark lands on it — not on no row at all.
      expect(custom).toMatchObject({
        id: "custom-unsloth-qwen3-0.6b-gguf-qwen3-0.6b-ud-q4_k_xl",
        active: true,
      });
      expect(rows.filter((row) => row.active)).toHaveLength(1);
    });
  });
});

function startedPulls(actions: readonly EmittedAction[]): string[] {
  return actions
    .filter(
      (action): action is Extract<EmittedAction, { type: "local_models_pull_started" }> =>
        action.type === "local_models_pull_started",
    )
    .map((action) => action.pull.modelId);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("waitFor timed out");
}
