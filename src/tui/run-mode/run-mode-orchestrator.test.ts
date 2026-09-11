import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../../config/config-cache.js";
import {
  getUserConfigPath,
  writeUserConfigFileSync,
} from "../../config/config-file.js";
import {
  USER_CONFIG_DEFAULTS,
  type UserConfigFile,
} from "../../config/config-schema.js";
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

  function seed(
    llm: UserConfigFile["llm"],
    managedModelId: string | null = "qwen-3.5-4b",
  ) {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        mode: "managed",
        managed: {
          ...USER_CONFIG_DEFAULTS.localModels.managed,
          modelId: managedModelId as never,
        },
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
      providers: {
        refresh: vi.fn(),
        ensureInlineModels: vi.fn(async () => {}),
      },
      localModels: { startDaemon: vi.fn(async () => true) },
    };
    return {
      actions,
      setActive,
      deps,
      orchestrator: new RunModeOrchestrator(deps),
    };
  }

  it("fusion: persists the mode with the orchestrator pinned, hot-applies it, starts the workers", async () => {
    seed(BOTH_LEGS);
    const app = harness();
    await app.orchestrator.setMode("fusion");
    expect(getConfig().llm?.activeTextProvider).toBe("openrouter");
    expect(getConfig().llm?.runMode).toEqual({
      mode: "fusion",
      fusion: {
        orchestratorProvider: "openrouter",
        workerProvider: "local-llama",
      },
    });
    expect(app.setActive).toHaveBeenCalledWith("openrouter");
    expect(app.deps.providers.refresh).toHaveBeenCalled();
    expect(app.deps.localModels.startDaemon).toHaveBeenCalled();
    expect(
      app.actions.some(
        (a) =>
          a.type === "runtime_info" &&
          /Fusion — orchestrator openrouter/.test(a.line),
      ),
    ).toBe(true);
    expect(app.actions.some((a) => a.type === "composer_notice")).toBe(false);
  });

  it("fusion: refuses with the degradation sentence when only one provider exists", async () => {
    seed({ ...BOTH_LEGS, providers: [BOTH_LEGS!.providers[0]!] });
    const app = harness();
    await app.orchestrator.setMode("fusion");
    expect(getConfig().llm?.runMode).toBeUndefined();
    expect(app.setActive).not.toHaveBeenCalled();
    const notice = app.actions.find((a) => a.type === "composer_notice");
    expect(notice).toBeDefined();
    // Not "needs a cloud provider": either leg may be cloud or local
    // now, so what is missing is a second provider, not a kind.
    expect((notice as { text: string }).text).toMatch(/needs two providers/);
  });

  it("fusion: refuses when the only provider would have to fill both legs", async () => {
    seed({
      ...BOTH_LEGS,
      activeTextProvider: "openrouter",
      activeEmbeddingProvider: "openrouter",
      providers: [BOTH_LEGS!.providers[1]!],
    });
    const app = harness();
    await app.orchestrator.setMode("fusion");
    expect(getConfig().llm?.runMode).toBeUndefined();
    expect(app.actions.find((a) => a.type === "composer_notice")).toMatchObject(
      {
        text: expect.stringMatching(/needs two providers/),
      },
    );
  });

  it("cloud out of fusion clears the mode and moves the provider in the same write", async () => {
    seed({
      ...BOTH_LEGS,
      activeTextProvider: "openrouter",
      runMode: { mode: "fusion" },
    });
    const app = harness();
    await app.orchestrator.setMode("cloud");
    expect(getConfig().llm?.runMode?.mode).toBe("cloud");
    expect(getConfig().llm?.activeTextProvider).toBe("openrouter");
    // Already the active provider: no hot-swap needed.
    expect(app.setActive).not.toHaveBeenCalled();
    expect(app.deps.localModels.startDaemon).not.toHaveBeenCalled();
  });

  it("local out of fusion moves the provider to the worker leg", async () => {
    seed({
      ...BOTH_LEGS,
      activeTextProvider: "openrouter",
      runMode: { mode: "fusion" },
    });
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
      app.actions.some(
        (a) => a.type === "runtime_info" && /saved, but switching/.test(a.line),
      ),
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
      (a) =>
        a.type === "runtime_info" && a.line.startsWith("fusion: 4 workers"),
    );
    expect(line).toBeDefined();
    expect((line as { line: string }).line).toMatch(
      /restart the local daemon.*--parallel 4/,
    );
  });

  it("setWorkers says nothing about restarting when the pin did not move", () => {
    // Against `"auto"` a number always moves the slot count — it pins
    // what the machine was deciding — so the quiet case is a re-pin to
    // the number already written.
    seed(BOTH_LEGS);
    const app = harness();
    // Pin it first: against `"auto"` a number always moves the slot
    // count, so the quiet case is a re-pin to what is already written.
    app.orchestrator.setWorkers(2);
    app.actions.length = 0;
    app.orchestrator.setWorkers(2);
    const line = app.actions.find((a) => a.type === "runtime_info") as {
      line: string;
    };
    expect(line.line).toBe("fusion: 2 workers");
  });

  it("setWorkers refuses an out-of-range count with a notice, writing nothing", () => {
    seed(BOTH_LEGS);
    const app = harness();
    app.orchestrator.setWorkers(99);
    expect(getConfig().localModels.managed.parallel).toBe("auto");
    expect(app.actions.find((a) => a.type === "composer_notice")).toMatchObject(
      {
        text: expect.stringMatching(/workers must be an integer 1-8/),
      },
    );
  });

  it("pins BOTH legs so the pair cannot drift with the provider order", async () => {
    seed(BOTH_LEGS);
    const app = harness();
    await app.orchestrator.setMode("fusion");
    expect(getConfig().llm?.runMode?.fusion).toEqual({
      orchestratorProvider: "openrouter",
      workerProvider: "local-llama",
    });
  });

  it("prefers a cloud provider that has credentials over the first one listed", async () => {
    seed({
      ...BOTH_LEGS,
      providers: [
        BOTH_LEGS!.providers[0]!,
        {
          id: "keyless",
          kind: "openai-compatible",
          baseUrl: "https://a.invalid",
        },
        {
          id: "openrouter",
          kind: "openrouter",
          defaultChatModel: "gpt",
          apiKey: "sk-test",
        },
      ],
    });
    const app = harness();
    await app.orchestrator.setMode("fusion");
    expect(getConfig().llm?.runMode?.fusion?.orchestratorProvider).toBe(
      "openrouter",
    );
    expect(getConfig().llm?.activeTextProvider).toBe("openrouter");
  });

  it("introduces the mode in chat on the way in, once", async () => {
    seed(BOTH_LEGS);
    const app = harness();
    await app.orchestrator.setMode("fusion");
    const intro = app.actions.filter((a) => a.type === "system_message");
    expect(intro).toHaveLength(1);
    expect((intro[0] as { text: string }).text).toContain(
      "Fusion splits the work between two models",
    );
    // Re-applying fusion (e.g. re-pinning the orchestrator) says nothing.
    app.actions.length = 0;
    await app.orchestrator.setMode("fusion");
    expect(app.actions.filter((a) => a.type === "system_message")).toHaveLength(
      0,
    );
  });

  it("says nothing in chat when the switch was refused", async () => {
    seed({ ...BOTH_LEGS, providers: [BOTH_LEGS!.providers[0]!] });
    const app = harness();
    await app.orchestrator.setMode("fusion");
    expect(app.actions.filter((a) => a.type === "system_message")).toHaveLength(
      0,
    );
  });
  it("swap: trades the two legs, and the active provider follows the orchestrator", async () => {
    seed(BOTH_LEGS);
    const app = harness();
    await app.orchestrator.setMode("fusion");
    expect(getConfig().llm?.runMode?.fusion?.orchestratorProvider).toBe(
      "openrouter",
    );

    await app.orchestrator.swapLegs();
    const fusion = getConfig().llm?.runMode?.fusion;
    expect(fusion?.orchestratorProvider).toBe("local-llama");
    expect(fusion?.workerProvider).toBe("openrouter");
    // The non-contradiction rule: `resolveRunMode` only honours fusion
    // while the active provider IS the orchestrator, so a swap that
    // moved the pins alone would drop the mode on the next read.
    expect(getConfig().llm?.activeTextProvider).toBe("local-llama");
    expect(app.orchestrator.current().effective).toBe("fusion");
  });

  it("swap: carries the per-leg model pins across with them", async () => {
    seed({
      ...BOTH_LEGS,
      activeTextProvider: "openrouter",
    });
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      llm: {
        ...BOTH_LEGS,
        activeTextProvider: "openrouter",
        runMode: {
          mode: "fusion",
          fusion: {
            orchestratorProvider: "openrouter",
            workerProvider: "local-llama",
            orchestratorModel: "cloud-label",
            workerModel: "local-label",
          },
        },
      },
    });
    resetConfigCache();
    const app = harness();
    await app.orchestrator.swapLegs();
    const fusion = getConfig().llm?.runMode?.fusion;
    // They are per-leg labels. Left where they were, both halves of the
    // composer would name the side that is no longer there.
    expect(fusion?.orchestratorModel).toBe("local-label");
    expect(fusion?.workerModel).toBe("cloud-label");
  });

  it("swap: refuses in one sentence when the route is not fusion", async () => {
    seed({ ...BOTH_LEGS, activeTextProvider: "openrouter" });
    const app = harness();
    await app.orchestrator.swapLegs();
    expect(getConfig().llm?.runMode?.fusion).toBeUndefined();
    expect(
      app.actions.some(
        (a) => a.type === "composer_notice" && /swap needs fusion/.test(a.text),
      ),
    ).toBe(true);
  });
});
