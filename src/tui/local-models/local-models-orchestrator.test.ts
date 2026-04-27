import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfig, resetConfigCache } from "../../config/index.js";
import {
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
