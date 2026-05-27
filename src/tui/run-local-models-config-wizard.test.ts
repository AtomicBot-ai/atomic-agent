import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureUserConfigFileSync,
  getConfig,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";
import { isCloudTextProviderReady } from "./run-local-models-config-wizard.js";

describe("isCloudTextProviderReady", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "startup-gate-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    delete process.env.OPENROUTER_API_KEY;
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.OPENROUTER_API_KEY;
    resetConfigCache();
  });

  it("treats an active cloud text provider with an env key as ready", () => {
    process.env.OPENROUTER_API_KEY = "env-key";
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "openrouter",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "openrouter",
            kind: "openrouter",
            defaultChatModel: "openrouter/auto",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(true);
  });

  it("does not treat an active cloud text provider without a key as ready", () => {
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "openrouter",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "openrouter",
            kind: "openrouter",
            defaultChatModel: "openrouter/auto",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(false);
  });
});
