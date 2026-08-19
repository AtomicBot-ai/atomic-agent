import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../config/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { TuiAction } from "../tui-action.js";
import { RunModeOrchestrator } from "./run-mode-orchestrator.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";

/** Shared bus: the orchestrator emits, the test reads back what it said. */
function makeBus() {
  const listeners = new Set<(action: TuiAction) => void>();
  const emitted: TuiAction[] = [];
  return {
    emitted,
    types: () => emitted.map((a) => a.type),
    subscribe(listener: (action: TuiAction) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(action: TuiAction) {
      emitted.push(action);
      for (const listener of [...listeners]) listener(action);
    },
  };
}

/**
 * Only `providerRegistry.setActive` is reachable from `setMode`, and the
 * ids it is called with are the assertion — a mode switch that swaps the
 * wrong leg is the failure this stub exists to catch.
 */
function makeRuntime() {
  const activated: string[] = [];
  return {
    activated,
    runtime: {
      providerRegistry: {
        setActive: async (id: string) => {
          activated.push(id);
        },
      },
    } as unknown as AgentRuntime,
  };
}

const LOCAL_LEG = {
  id: "local-llama",
  kind: "llama-server",
  url: "http://127.0.0.1:8080",
  model: "qwen3-4b.gguf",
};
const CLOUD_LEG = {
  id: "openrouter",
  kind: "openrouter",
  defaultChatModel: "vendor/big",
};

function seed(
  stateDir: string,
  llm: {
    activeTextProvider: string;
    providers: unknown[];
    runMode?: unknown;
  },
): void {
  writeFileSync(
    join(stateDir, "config.json"),
    JSON.stringify({
      llm: {
        activeEmbeddingProvider: llm.activeTextProvider,
        toolTransport: "auto",
        ...llm,
      },
    }),
    "utf8",
  );
  resetConfigCache();
}

function onDisk(stateDir: string): {
  activeTextProvider?: string;
  runMode?: { mode?: string };
} {
  return (
    JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")).llm ?? {}
  );
}

describe("RunModeOrchestrator.setMode", () => {
  let stateDir: string;
  let original: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "run-mode-orch-"));
    mkdirSync(stateDir, { recursive: true });
    original = process.env[STATE_DIR_ENV];
    process.env[STATE_DIR_ENV] = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    if (original === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = original;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  /**
   * The composer's model name comes from the PROVIDERS mirror, not from
   * this panel's, and a mode switch is the one thing that moves the
   * active provider without going through the providers orchestrator.
   * Without this republish the swap really happened — config written,
   * registry moved, strip repainted — and the composer went on naming
   * the model of the leg the operator had just switched away from.
   */
  it("republishes the providers mirror once the swap has landed", async () => {
    seed(stateDir, {
      activeTextProvider: "local-llama",
      providers: [LOCAL_LEG, CLOUD_LEG],
      runMode: { mode: "local" },
    });
    const bus = makeBus();
    const { runtime, activated } = makeRuntime();
    await new RunModeOrchestrator(runtime, bus).setMode("cloud");

    expect(activated).toEqual(["openrouter"]);
    expect(bus.types()).toContain("providers_refresh_requested");
    // After the swap, never before: a mirror rebuilt while the registry
    // still points at the old leg would republish the stale row set.
    expect(bus.types().indexOf("providers_refresh_requested")).toBeGreaterThan(
      bus.types().indexOf("run_mode_change_settled"),
    );
  });

  it("does not republish when the switch never happened", async () => {
    seed(stateDir, {
      activeTextProvider: "local-llama",
      providers: [LOCAL_LEG],
      runMode: { mode: "local" },
    });
    const bus = makeBus();
    const { runtime } = makeRuntime();
    await new RunModeOrchestrator(runtime, bus).setMode("cloud");
    expect(bus.types()).not.toContain("providers_refresh_requested");
  });

  it("takes an unconfigured Cloud to the add-a-provider wizard", async () => {
    seed(stateDir, {
      activeTextProvider: "local-llama",
      providers: [LOCAL_LEG],
      runMode: { mode: "local" },
    });
    const bus = makeBus();
    const { runtime } = makeRuntime();
    await new RunModeOrchestrator(runtime, bus).setMode("cloud");

    expect(bus.types()).toEqual(
      expect.arrayContaining([
        "ui_mode_set",
        "tab_changed",
        "llm_mode_set",
        "providers_wizard_opened",
      ]),
    );
    expect(bus.emitted).toContainEqual({ type: "llm_mode_set", mode: "cloud" });
  });

  /**
   * "For this specific type of model": a missing llama-server is not
   * fixed by the cloud wizard, so Local lands on the Local pane, which
   * is where the backend, the model and the daemon are.
   */
  it("takes an unconfigured Local to the local pane, not the cloud wizard", async () => {
    seed(stateDir, {
      activeTextProvider: "openrouter",
      providers: [CLOUD_LEG],
      runMode: { mode: "cloud" },
    });
    const bus = makeBus();
    const { runtime } = makeRuntime();
    await new RunModeOrchestrator(runtime, bus).setMode("local");

    expect(bus.emitted).toContainEqual({ type: "llm_mode_set", mode: "local" });
    expect(bus.types()).not.toContain("providers_wizard_opened");
  });

  /**
   * The silent hole this closes: `resolveRunMode` does not degrade a
   * `local` request with no local leg, so the old code wrote
   * `runMode.mode = "local"` while leaving a cloud provider active —
   * a stored mode that resolves to something else on the very next
   * read, with no swap and not one word to the operator.
   */
  it("refuses to store a Local it cannot run, and says so", async () => {
    seed(stateDir, {
      activeTextProvider: "openrouter",
      providers: [CLOUD_LEG],
      runMode: { mode: "cloud" },
    });
    const bus = makeBus();
    const { runtime, activated } = makeRuntime();
    await new RunModeOrchestrator(runtime, bus).setMode("local");

    expect(onDisk(stateDir).runMode?.mode).toBe("cloud");
    expect(onDisk(stateDir).activeTextProvider).toBe("openrouter");
    expect(activated).toEqual([]);
    const settled = bus.emitted.find((a) => a.type === "run_mode_change_settled");
    expect(settled).toMatchObject({ error: expect.stringContaining("llama-server") });
  });

  it("takes an unconfigured Fusion to whichever leg is missing", async () => {
    seed(stateDir, {
      activeTextProvider: "openrouter",
      providers: [CLOUD_LEG],
      runMode: { mode: "cloud" },
    });
    const bus = makeBus();
    const { runtime } = makeRuntime();
    await new RunModeOrchestrator(runtime, bus).setMode("fusion");
    expect(bus.emitted).toContainEqual({ type: "llm_mode_set", mode: "local" });
  });

  it("still applies a mode both legs can support", async () => {
    seed(stateDir, {
      activeTextProvider: "local-llama",
      providers: [LOCAL_LEG, CLOUD_LEG],
      runMode: { mode: "local" },
    });
    const bus = makeBus();
    const { runtime, activated } = makeRuntime();
    await new RunModeOrchestrator(runtime, bus).setMode("fusion", 65);

    // The fusion rule pins the CLOUD leg as primary; the dial rides along
    // in the same write.
    expect(activated).toEqual(["openrouter"]);
    expect(onDisk(stateDir).runMode).toMatchObject({
      mode: "fusion",
      fusion: { cloudShare: 65 },
    });
    expect(bus.types()).not.toContain("providers_wizard_opened");
  });
});
