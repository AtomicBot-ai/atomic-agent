import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../../config/config-cache.js";
import { getUserConfigPath, writeUserConfigFileSync } from "../../config/config-file.js";
import { USER_CONFIG_DEFAULTS, type UserConfigFile } from "../../config/config-schema.js";
import { getConfig } from "../../config/index.js";
import type { TuiAction } from "../tui-action.js";
import { RunModeOrchestrator } from "./run-mode-orchestrator.js";

const BOTH_LEGS: UserConfigFile["llm"] = {
  activeTextProvider: "local-llama",
  activeEmbeddingProvider: "local-llama",
  toolTransport: "auto",
  providers: [
    { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
    { id: "openrouter", kind: "openrouter", defaultChatModel: "gpt" },
  ],
};

describe("RunModeOrchestrator.setMode", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-run-mode-orch-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  function seed(llm: UserConfigFile["llm"], managedModelId: string | null = "qwen-3.5-4b") {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        mode: "managed",
        managed: { ...USER_CONFIG_DEFAULTS.localModels.managed, modelId: managedModelId as never },
      },
      ...(llm ? { llm } : {}),
    });
    resetConfigCache();
  }

  function harness() {
    const actions: TuiAction[] = [];
    const setActive = vi.fn(async () => ({}) as never);
    const deps = {
      runtime: { providerRegistry: { setActive } as never },
      bus: { emit: (action: TuiAction) => actions.push(action) },
      providers: { refresh: vi.fn(), ensureInlineModels: vi.fn(async () => {}) },
      localModels: { startDaemon: vi.fn(async () => true) },
    };
    return { actions, setActive, deps, orchestrator: new RunModeOrchestrator(deps) };
  }

  it("fusion: persists the mode with the orchestrator pinned, hot-applies it, starts the workers", async () => {
    seed(BOTH_LEGS);
    const app = harness();
    await app.orchestrator.setMode("fusion");
    expect(getConfig().llm?.activeTextProvider).toBe("openrouter");
    expect(getConfig().llm?.runMode).toEqual({
      mode: "fusion",
      fusion: { orchestratorProvider: "openrouter" },
    });
    expect(app.setActive).toHaveBeenCalledWith("openrouter");
    expect(app.deps.providers.refresh).toHaveBeenCalled();
    expect(app.deps.localModels.startDaemon).toHaveBeenCalled();
    expect(app.actions.some((a) => a.type === "runtime_info" && /Fusion — orchestrator openrouter/.test(a.line))).toBe(true);
    expect(app.actions.some((a) => a.type === "composer_notice")).toBe(false);
  });

  it("fusion: refuses with the degradation sentence when there is no cloud provider", async () => {
    seed({ ...BOTH_LEGS, providers: [BOTH_LEGS!.providers[0]!] });
    const app = harness();
    await app.orchestrator.setMode("fusion");
    expect(getConfig().llm?.runMode).toBeUndefined();
    expect(app.setActive).not.toHaveBeenCalled();
    const notice = app.actions.find((a) => a.type === "composer_notice");
    expect(notice).toBeDefined();
    expect((notice as { text: string }).text).toMatch(/needs a cloud orchestrator/);
  });

  it("fusion: refuses when there is no llama-server provider", async () => {
    seed({
      ...BOTH_LEGS,
      activeTextProvider: "openrouter",
      activeEmbeddingProvider: "openrouter",
      providers: [BOTH_LEGS!.providers[1]!],
    });
    const app = harness();
    await app.orchestrator.setMode("fusion");
    expect(getConfig().llm?.runMode).toBeUndefined();
    expect(app.actions.find((a) => a.type === "composer_notice")).toMatchObject({
      text: expect.stringMatching(/needs local workers/),
    });
  });

  it("cloud out of fusion clears the mode and moves the provider in the same write", async () => {
    seed({ ...BOTH_LEGS, activeTextProvider: "openrouter", runMode: { mode: "fusion" } });
    const app = harness();
    await app.orchestrator.setMode("cloud");
    expect(getConfig().llm?.runMode?.mode).toBe("cloud");
    expect(getConfig().llm?.activeTextProvider).toBe("openrouter");
    // Already the active provider: no hot-swap needed.
    expect(app.setActive).not.toHaveBeenCalled();
    expect(app.deps.localModels.startDaemon).not.toHaveBeenCalled();
  });

  it("local out of fusion moves the provider to the worker leg", async () => {
    seed({ ...BOTH_LEGS, activeTextProvider: "openrouter", runMode: { mode: "fusion" } });
    const app = harness();
    await app.orchestrator.setMode("local");
    expect(getConfig().llm?.runMode?.mode).toBe("local");
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
    expect(app.setActive).toHaveBeenCalledWith("local-llama");
  });

  it("keeps the saved mode and reports when the hot-swap throws", async () => {
    seed(BOTH_LEGS);
    const app = harness();
    app.setActive.mockRejectedValueOnce(new Error("boom"));
    await app.orchestrator.setMode("fusion");
    expect(getConfig().llm?.runMode?.mode).toBe("fusion");
    expect(
      app.actions.some((a) => a.type === "runtime_info" && /saved, but switching/.test(a.line)),
    ).toBe(true);
  });

  it("does not start the daemon when nothing is set to run on it", async () => {
    seed(BOTH_LEGS, null);
    const app = harness();
    await app.orchestrator.setMode("fusion");
    expect(app.deps.localModels.startDaemon).not.toHaveBeenCalled();
  });

  it("setWorkers writes both counts and says how to apply the new slot count", () => {
    seed(BOTH_LEGS);
    const app = harness();
    app.orchestrator.setWorkers(4);
    expect(getConfig().llm?.runMode?.fusion?.workers).toBe(4);
    expect(getConfig().localModels.managed.parallel).toBe(4);
    expect(app.deps.providers.refresh).toHaveBeenCalled();
    const line = app.actions.find(
      (a) => a.type === "runtime_info" && a.line.startsWith("fusion: 4 workers"),
    );
    expect(line).toBeDefined();
    expect((line as { line: string }).line).toMatch(/restart the local daemon.*--parallel 4/);
  });

  it("setWorkers says nothing about restarting when the count did not move", () => {
    seed(BOTH_LEGS);
    const app = harness();
    app.orchestrator.setWorkers(2);
    const line = app.actions.find((a) => a.type === "runtime_info") as { line: string };
    expect(line.line).toBe("fusion: 2 workers");
  });

  it("setWorkers refuses an out-of-range count with a notice, writing nothing", () => {
    seed(BOTH_LEGS);
    const app = harness();
    app.orchestrator.setWorkers(99);
    expect(getConfig().localModels.managed.parallel).toBe(2);
    expect(app.actions.find((a) => a.type === "composer_notice")).toMatchObject({
      text: expect.stringMatching(/workers must be an integer 1-8/),
    });
  });
});
