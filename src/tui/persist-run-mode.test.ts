import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../config/config-cache.js";
import { getUserConfigPath, writeUserConfigFileSync } from "../config/config-file.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import { getConfig } from "../config/index.js";
import { RunModePersistError, setRunModeInConfig } from "./persist-run-mode.js";

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
          { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
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
    return JSON.parse(readFileSync(getUserConfigPath(stateDir), "utf8")) as Record<
      string,
      unknown
    >;
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

  it("refuses a provider that is not configured, without writing", () => {
    expect(() => setRunModeInConfig({ mode: "cloud", activeTextProvider: "ghost" })).toThrow(
      RunModePersistError,
    );
    expect(getConfig().llm?.runMode).toBeUndefined();
  });
});
