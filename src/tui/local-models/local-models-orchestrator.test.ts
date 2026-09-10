import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getConfig,
  resetConfigCache,
  USER_CONFIG_VERSION,
} from "../../config/index.js";
import {
  resolveBackendDir,
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
    const orchestrator = new LocalModelsOrchestrator({
      emit() {},
      subscribe: () => () => {},
    });
    (
      orchestrator as unknown as { daemonSupervised: boolean }
    ).daemonSupervised = true;
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
      (
        orchestrator as unknown as { daemonSupervised: boolean }
      ).daemonSupervised = false;
      await orchestrator.shutdown();
      expect(stopped()).toBe(0);
    });
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
        subscribe: () => () => {},
      });
      await orchestrator.refresh();
      const snapshot = actions.find(
        (
          action,
        ): action is Extract<
          EmittedAction,
          { type: "local_models_snapshot_loaded" }
        > => action.type === "local_models_snapshot_loaded",
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
