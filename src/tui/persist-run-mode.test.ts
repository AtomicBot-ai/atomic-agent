import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../config/config-cache.js";
import {
  getUserConfigPath,
  writeUserConfigFileSync,
} from "../config/config-file.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import { getConfig } from "../config/index.js";
import {
  RunModePersistError,
  setFusionWorkersInConfig,
  setRunModeInConfig,
} from "./persist-run-mode.js";

describe("setRunModeInConfig", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-run-mode-persist-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      llm: {
        activeTextProvider: "local-llama",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          {
            id: "local-llama",
            kind: "llama-server",
            url: "http://127.0.0.1:19091",
          },
          { id: "openrouter", kind: "openrouter", defaultChatModel: "gpt" },
        ],
      },
    });
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  function file(): Record<string, unknown> {
    return JSON.parse(
      readFileSync(getUserConfigPath(stateDir), "utf8"),
    ) as Record<string, unknown>;
  }

  it("moves the mode and the active provider in one write", () => {
    setRunModeInConfig({ mode: "fusion", activeTextProvider: "openrouter" });
    const llm = file().llm as { activeTextProvider: string; runMode: unknown };
    expect(llm.activeTextProvider).toBe("openrouter");
    expect(llm.runMode).toEqual({ mode: "fusion" });
    // The cache was reset: the runtime reads the same answer.
    expect(getConfig().llm?.runMode?.mode).toBe("fusion");
    expect(getConfig().llm?.activeTextProvider).toBe("openrouter");
  });

  it("merges the fusion block over what was stored", () => {
    setRunModeInConfig({
      mode: "fusion",
      activeTextProvider: "openrouter",
      fusion: { orchestratorProvider: "openrouter", workers: 3 },
    });
    setRunModeInConfig({
      mode: "fusion",
      activeTextProvider: "openrouter",
      fusion: { workers: 4 },
    });
    expect(getConfig().llm?.runMode).toEqual({
      mode: "fusion",
      fusion: { orchestratorProvider: "openrouter", workers: 4 },
    });
  });

  it("mirrors the worker count onto localModels.managed.parallel in the same write", () => {
    setRunModeInConfig({
      mode: "fusion",
      activeTextProvider: "openrouter",
      fusion: { workers: 5 },
      managedParallel: 5,
    });
    expect(getConfig().localModels.managed.parallel).toBe(5);
    expect(getConfig().llm?.runMode?.fusion?.workers).toBe(5);
  });

  it("clears fusion by writing the plain mode with its own provider", () => {
    setRunModeInConfig({ mode: "fusion", activeTextProvider: "openrouter" });
    setRunModeInConfig({ mode: "local", activeTextProvider: "local-llama" });
    expect(getConfig().llm?.runMode?.mode).toBe("local");
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
  });

  describe("re-pinning a fusion leg", () => {
    beforeEach(() => {
      writeUserConfigFileSync(getUserConfigPath(stateDir), {
        ...USER_CONFIG_DEFAULTS,
        llm: {
          activeTextProvider: "openrouter",
          activeEmbeddingProvider: "local-llama",
          toolTransport: "auto",
          providers: [
            {
              id: "local-llama",
              kind: "llama-server",
              url: "http://127.0.0.1:19091",
            },
            {
              id: "local-llama-2",
              kind: "llama-server",
              url: "http://127.0.0.1:19092",
            },
            { id: "openrouter", kind: "openrouter", defaultChatModel: "gpt" },
            { id: "openrouter-2", kind: "openrouter", defaultChatModel: "x" },
          ],
          runMode: {
            mode: "fusion",
            fusion: {
              orchestratorProvider: "openrouter",
              orchestratorModel: "gpt-pinned",
              workerProvider: "local-llama",
              workerModel: "qwen-pinned",
            },
          },
        },
      });
      resetConfigCache();
    });

    it("drops a leg's model pin when the leg moves to another provider", () => {
      setRunModeInConfig({
        mode: "fusion",
        activeTextProvider: "openrouter-2",
        fusion: {
          orchestratorProvider: "openrouter-2",
          workerProvider: "local-llama-2",
        },
      });
      expect(getConfig().llm?.runMode?.fusion).toEqual({
        orchestratorProvider: "openrouter-2",
        workerProvider: "local-llama-2",
      });
    });

    it("drops only the pin of the leg that moved", () => {
      setRunModeInConfig({
        mode: "fusion",
        activeTextProvider: "openrouter-2",
        fusion: {
          orchestratorProvider: "openrouter-2",
          workerProvider: "local-llama",
        },
      });
      expect(getConfig().llm?.runMode?.fusion).toEqual({
        orchestratorProvider: "openrouter-2",
        workerProvider: "local-llama",
        workerModel: "qwen-pinned",
      });
    });

    it("keeps the pins when the legs are re-applied unchanged", () => {
      setRunModeInConfig({
        mode: "fusion",
        activeTextProvider: "openrouter",
        fusion: {
          orchestratorProvider: "openrouter",
          workerProvider: "local-llama",
        },
      });
      expect(getConfig().llm?.runMode?.fusion).toEqual({
        orchestratorProvider: "openrouter",
        orchestratorModel: "gpt-pinned",
        workerProvider: "local-llama",
        workerModel: "qwen-pinned",
      });
    });

    it("keeps a model pin on a leg that was never pinned to a provider", () => {
      const stored = file();
      (stored.llm as { runMode: unknown }).runMode = {
        mode: "fusion",
        fusion: { orchestratorModel: "hand-o", workerModel: "hand-w" },
      };
      writeFileSync(getUserConfigPath(stateDir), JSON.stringify(stored));
      resetConfigCache();
      setRunModeInConfig({
        mode: "fusion",
        activeTextProvider: "openrouter",
        fusion: {
          orchestratorProvider: "openrouter",
          workerProvider: "local-llama",
        },
      });
      expect(getConfig().llm?.runMode?.fusion).toEqual({
        orchestratorProvider: "openrouter",
        orchestratorModel: "hand-o",
        workerProvider: "local-llama",
        workerModel: "hand-w",
      });
    });

    it("takes a new model pin that comes with the move", () => {
      setRunModeInConfig({
        mode: "fusion",
        activeTextProvider: "openrouter-2",
        fusion: {
          orchestratorProvider: "openrouter-2",
          orchestratorModel: "x-pinned",
        },
      });
      expect(getConfig().llm?.runMode?.fusion?.orchestratorModel).toBe(
        "x-pinned",
      );
    });
  });

  it("refuses a provider that is not configured, without writing", () => {
    expect(() =>
      setRunModeInConfig({ mode: "cloud", activeTextProvider: "ghost" }),
    ).toThrow(RunModePersistError);
    expect(getConfig().llm?.runMode).toBeUndefined();
  });

  it("moves the worker count and the llama-server slot count together", () => {
    setFusionWorkersInConfig(4);
    expect(getConfig().llm?.runMode?.fusion?.workers).toBe(4);
    expect(getConfig().localModels.managed.parallel).toBe(4);
    const llm = file().llm as { runMode?: { mode?: string } };
    // The count is not a mode change: whatever mode was stored stays.
    expect(llm.runMode?.mode).toBeUndefined();
  });

  it("keeps the stored mode and the orchestrator pin when only the count moves", () => {
    setRunModeInConfig({
      mode: "fusion",
      activeTextProvider: "openrouter",
      fusion: { orchestratorProvider: "openrouter" },
    });
    setFusionWorkersInConfig(6);
    expect(getConfig().llm?.runMode).toEqual({
      mode: "fusion",
      fusion: { orchestratorProvider: "openrouter", workers: 6 },
    });
    expect(getConfig().llm?.activeTextProvider).toBe("openrouter");
  });

  it("refuses a count outside 1..8 without writing", () => {
    for (const workers of [0, 9, 2.5]) {
      expect(() => setFusionWorkersInConfig(workers)).toThrow(
        RunModePersistError,
      );
    }
    // Untouched means untouched: the slot count is still the machine's
    // to decide, which is what `"auto"` says.
    expect(getConfig().localModels.managed.parallel).toBe("auto");
  });
});
