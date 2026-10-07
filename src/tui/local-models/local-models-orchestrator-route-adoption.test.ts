import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../local-llm/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../local-llm/index.js")>("../../local-llm/index.js");
  return {
    ...actual,
    // The pid fixture represents this model, regardless of a real server on its port.
    fetchServedModelIds: vi.fn(async () => ["qwen-3.5-4b"]),
  };
});

import {
  getUserConfigPath,
  writeUserConfigFileSync,
} from "../../config/config-file.js";
import {
  USER_CONFIG_DEFAULTS,
  type UserConfigFile,
} from "../../config/config-schema.js";
import { getConfig, resetConfigCache } from "../../config/index.js";
import {
  getLocalModelDef,
  resolveBackendDir,
  resolveModelFilePath,
  resolvePidFilePath,
  resolveServerBinPath,
} from "../../local-llm/index.js";
import { resolvePlatformAsset } from "../../local-llm/backend/platform-assets.js";
import { ProviderRegistry } from "../../llm/provider/registry/provider-registry.js";
import type { LlmProvider } from "../../llm/provider/llm-provider.js";
import { setActiveTextProviderInConfig } from "../../config/llm-provider-commands.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

type Internals = {
  daemonSupervised: boolean;
  supervisor: { tick(): Promise<void>; stop(): void };
  stopDaemonSilent: () => Promise<void>;
  ensureEmbeddingPaired: () => Promise<void>;
  applyBackendAutoUpdate: () => Promise<boolean>;
};

const CLOUD_ACTIVE: UserConfigFile["llm"] = {
  activeTextProvider: "openrouter",
  activeEmbeddingProvider: "local-llama",
  toolTransport: "auto",
  providers: [
    { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
    { id: "openrouter", kind: "openrouter", defaultChatModel: "gpt" },
  ],
};

/**
 * A managed daemon already running when the TUI launches with a cloud
 * provider active is skipped by the launch adoption. Moving the route
 * onto it mid-session must take it over — for the supervisor and for
 * teardown — or a `kill -9` is never restarted and `stopOnExit` never
 * stops it.
 */
describe("LocalModelsOrchestrator adopts the daemon when the route moves onto it", () => {
  let stateDir: string;
  const built: Internals[] = [];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-route-adopt-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    for (const inner of built.splice(0)) inner.supervisor.stop();
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function seed(llm: UserConfigFile["llm"]): string {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        mode: "managed",
        managed: {
          ...USER_CONFIG_DEFAULTS.localModels.managed,
          modelId: "qwen-3.5-4b" as never,
        },
      },
      llm,
    });
    resetConfigCache();
    const dataDir = getConfig().paths.localModelsDataDir;
    mkdirSync(resolveBackendDir(dataDir), { recursive: true });
    writeFileSync(
      resolveServerBinPath(dataDir, resolvePlatformAsset().binaryName),
      "",
    );
    const def = getLocalModelDef("qwen-3.5-4b");
    mkdirSync(join(dataDir, "models", def.id), { recursive: true });
    writeFileSync(resolveModelFilePath(dataDir, def.id, def.filename), "stub");
    return dataDir;
  }

  /** A live pid that is not ours stands in for the running llama-server. */
  function daemonRunning(dataDir: string): void {
    writeFileSync(resolvePidFilePath(dataDir), String(process.ppid));
  }

  function daemonDied(dataDir: string): void {
    rmSync(resolvePidFilePath(dataDir), { force: true });
  }

  function build() {
    const orchestrator = new LocalModelsOrchestrator({
      emit() {},
      subscribe: () => () => {},
    });
    const inner = orchestrator as unknown as Internals;
    built.push(inner);
    const start = vi.spyOn(orchestrator, "startDaemon").mockResolvedValue(true);
    const stopChat = vi
      .spyOn(orchestrator, "stopChatDaemonOnly")
      .mockResolvedValue(true);
    const stopAll = vi.spyOn(orchestrator, "stopDaemon").mockResolvedValue();
    const stopOnQuit = vi.spyOn(inner, "stopDaemonSilent").mockResolvedValue();
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();
    vi.spyOn(inner, "ensureEmbeddingPaired").mockResolvedValue();
    vi.spyOn(inner, "applyBackendAutoUpdate").mockResolvedValue(true);
    return { orchestrator, inner, start, stopChat, stopAll, stopOnQuit };
  }

  it("launch on cloud, switch to local: the supervisor owns it and restarts it when it dies", async () => {
    const dataDir = seed(CLOUD_ACTIVE);
    daemonRunning(dataDir);
    const { orchestrator, inner, start } = build();

    await orchestrator.autoStartIfReady();
    expect(inner.daemonSupervised).toBe(false);

    // The registry announces the swap before the caller persists it, so
    // the config still names the cloud provider here.
    expect(orchestrator.adoptDaemonForRoute("local-llama")).toBe(true);
    expect(inner.daemonSupervised).toBe(true);
    expect(start).not.toHaveBeenCalled();

    daemonDied(dataDir);
    await inner.supervisor.tick();
    await inner.supervisor.tick();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("the adopted daemon is stopped at quit like one adopted at launch", async () => {
    const dataDir = seed(CLOUD_ACTIVE);
    daemonRunning(dataDir);
    const { orchestrator, stopOnQuit } = build();
    await orchestrator.autoStartIfReady();
    orchestrator.adoptDaemonForRoute("local-llama");
    await orchestrator.shutdown();
    expect(stopOnQuit).toHaveBeenCalledTimes(1);
  });

  it("a Fusion mode with the local leg on the daemon adopts it too", () => {
    const dataDir = seed({
      ...CLOUD_ACTIVE!,
      runMode: {
        mode: "fusion",
        fusion: { orchestratorProvider: "openrouter", workerProvider: "local-llama" },
      },
    } as UserConfigFile["llm"]);
    daemonRunning(dataDir);
    const { orchestrator, inner } = build();
    expect(orchestrator.adoptDaemonForRoute()).toBe(true);
    expect(inner.daemonSupervised).toBe(true);
  });

  it("switching to a cloud provider adopts nothing", () => {
    const dataDir = seed(CLOUD_ACTIVE);
    daemonRunning(dataDir);
    const { orchestrator, inner } = build();
    expect(orchestrator.adoptDaemonForRoute("openrouter")).toBe(false);
    expect(inner.daemonSupervised).toBe(false);
  });

  it("switching to local with no daemon running starts nothing", async () => {
    seed(CLOUD_ACTIVE);
    const { orchestrator, inner, start } = build();
    expect(orchestrator.adoptDaemonForRoute("local-llama")).toBe(false);
    expect(inner.daemonSupervised).toBe(false);
    await inner.supervisor.tick();
    await inner.supervisor.tick();
    expect(start).not.toHaveBeenCalled();
  });

  it("launch with local active still adopts the running daemon", async () => {
    const dataDir = seed({ ...CLOUD_ACTIVE!, activeTextProvider: "local-llama" });
    daemonRunning(dataDir);
    const { orchestrator, inner, start } = build();
    await orchestrator.autoStartIfReady();
    expect(inner.daemonSupervised).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it("switching back to cloud leaves the daemon running and owned", async () => {
    const dataDir = seed(CLOUD_ACTIVE);
    daemonRunning(dataDir);
    const { orchestrator, inner, stopChat, stopAll, stopOnQuit } = build();
    orchestrator.adoptDaemonForRoute("local-llama");
    setActiveTextProviderInConfig("local-llama");
    orchestrator.adoptDaemonForRoute("openrouter");
    setActiveTextProviderInConfig("openrouter");
    expect(inner.daemonSupervised).toBe(true);
    expect(stopChat).not.toHaveBeenCalled();
    expect(stopAll).not.toHaveBeenCalled();
    expect(stopOnQuit).not.toHaveBeenCalled();
  });
});

describe("ProviderRegistry.onActiveTextChanged", () => {
  function registry(): ProviderRegistry {
    const fake = (id: string) =>
      ({ id, close: async () => {} }) as unknown as LlmProvider;
    const Ctor = ProviderRegistry as unknown as new (
      active: string,
      providers: Map<string, LlmProvider>,
    ) => ProviderRegistry;
    return new Ctor(
      "openrouter",
      new Map([
        ["openrouter", fake("openrouter")],
        ["local-llama", fake("local-llama")],
      ]),
    );
  }

  it("reports every swap with the new id, and stops after unsubscribe", async () => {
    const reg = registry();
    const seen: string[] = [];
    const off = reg.onActiveTextChanged((id) => seen.push(id));
    await reg.setActive("local-llama");
    await reg.setActive("openrouter");
    off();
    await reg.setActive("local-llama");
    expect(seen).toEqual(["local-llama", "openrouter"]);
  });

  it("a throwing listener does not fail the swap", async () => {
    const reg = registry();
    reg.onActiveTextChanged(() => {
      throw new Error("boom");
    });
    await expect(reg.setActive("local-llama")).resolves.toBeDefined();
    expect(reg.activeText.id).toBe("local-llama");
  });
});
