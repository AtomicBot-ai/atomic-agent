import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decideOnboarding, needsOnboarding } from "./needs-onboarding.js";
import { persistOnboardingState } from "../persist-onboarding-state.js";
import { getConfig, resetConfigCache, USER_CONFIG_VERSION } from "../../config/index.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";
const STAMP = "2026-08-21T18:04:05.000Z";

function writeConfig(stateDir: string, patch: Record<string, unknown>): void {
  writeFileSync(
    join(stateDir, "config.json"),
    JSON.stringify({ version: USER_CONFIG_VERSION, ...patch }, null, 2),
  );
  resetConfigCache();
}

describe("decideOnboarding", () => {
  let stateDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "onboarding-decide-"));
    mkdirSync(stateDir, { recursive: true });
    originalEnv = process.env[STATE_DIR_ENV];
    process.env[STATE_DIR_ENV] = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = originalEnv;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("opens on a fresh install", () => {
    expect(decideOnboarding()).toEqual({ needed: true, reason: "fresh_install" });
  });

  it("stays shut once the flow completed", () => {
    persistOnboardingState({ completedAt: STAMP });
    expect(decideOnboarding()).toEqual({ needed: false, reason: "completed" });
  });

  it("stays shut once the operator escaped out — the v0.3.6 groundhog bug", () => {
    persistOnboardingState({ skippedAt: STAMP });
    expect(needsOnboarding()).toBe(false);
  });

  it("stays shut when a cloud provider is already configured", () => {
    writeConfig(stateDir, {
      llm: {
        activeTextProvider: "openrouter",
        activeEmbeddingProvider: "local-llama",
        providers: [
          { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
          {
            id: "openrouter",
            kind: "openrouter",
            apiKeyEnv: "OPENROUTER_API_KEY",
            chatModel: "openrouter/auto",
          },
        ],
      },
    });
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    try {
      expect(decideOnboarding()).toEqual({ needed: false, reason: "backend_configured" });
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("stays shut when an external llama-server URL was configured", () => {
    writeConfig(stateDir, { localModels: { mode: "external", url: "http://10.0.0.4:8080" } });
    expect(decideOnboarding()).toEqual({ needed: false, reason: "backend_configured" });
  });

  it("still opens on the shipped defaults — a default URL nobody chose is not a backend", () => {
    expect(getConfig().localModels.mode).toBe("external");
    expect(getConfig().localModels.url).toBe("http://127.0.0.1:8080");
    expect(needsOnboarding()).toBe(true);
  });

  it("stays shut when a managed model id was picked and pulled", () => {
    writeConfig(stateDir, {
      localModels: { mode: "managed", managed: { modelId: "gemma-4-e4b" } },
    });
    // `isManagedModeReadyOnDisk` also wants the weights on disk, which a
    // temp state dir does not have; `isLocalBackendConfigured` is the one
    // that answers here, and a chosen model is a deliberate choice.
    expect(decideOnboarding()).toEqual({ needed: false, reason: "backend_configured" });
  });
});
