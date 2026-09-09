import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetConfigCache } from "../../config/index.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import {
  persistLlmProvider,
  setActiveTextProviderInConfig,
} from "../persist-llm-provider.js";
import { restartLocalDaemon } from "./local-models-daemon-restart.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

type Emitted = { type: string; line?: string; message?: string };

/**
 * `/llm restart` (and the LLM pane's `R`) come down to this function, so
 * these tests pin the three branches an operator can land in and the one
 * ordering guarantee that makes the action safe: chat daemon down, chat
 * daemon up, embedding daemon untouched throughout.
 *
 * Config is real (a temp state dir + the same persist helpers the TUI
 * uses); only the two daemon-lifecycle calls are injected fakes, so no
 * llama-server is ever spawned.
 */
describe("restartLocalDaemon", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-restart-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeDeps(startResult = true): {
    deps: Parameters<typeof restartLocalDaemon>[0];
    emitted: Emitted[];
    calls: string[];
    stopChatDaemonOnly: ReturnType<typeof vi.fn>;
    startDaemon: ReturnType<typeof vi.fn>;
  } {
    const emitted: Emitted[] = [];
    const calls: string[] = [];
    const stopChatDaemonOnly = vi.fn(async () => {
      calls.push("stop");
    });
    const startDaemon = vi.fn(async () => {
      calls.push("start");
      return startResult;
    });
    return {
      deps: {
        emit: (action) => {
          emitted.push(action as Emitted);
        },
        stopChatDaemonOnly,
        startDaemon,
      },
      emitted,
      calls,
      stopChatDaemonOnly,
      startDaemon,
    };
  }

  const lines = (emitted: Emitted[]): string[] =>
    emitted.filter((a) => a.type === "runtime_info").map((a) => a.line ?? "");

  it("stops the chat daemon and starts it again, in that order", async () => {
    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { modelId: "qwen-3.5-4b" },
    });
    resetConfigCache();
    const { deps, emitted, calls, stopChatDaemonOnly, startDaemon } = makeDeps();

    await expect(restartLocalDaemon(deps)).resolves.toBe(true);

    // The ordering IS the feature: a start that races an unfinished stop
    // lands on a port the dying process still holds.
    expect(calls).toEqual(["stop", "start"]);
    expect(stopChatDaemonOnly).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(lines(emitted)).toContain("local-llm: restarting the model server…");
    // Never `errorLine` on a healthy restart: every refresh wipes it, and
    // onboarding reads a set error line as "the download failed".
    expect(emitted.some((a) => a.type === "local_models_daemon_error_set")).toBe(false);
  });

  it("reports a start that failed without inventing success", async () => {
    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { modelId: "qwen-3.5-4b" },
    });
    resetConfigCache();
    const { deps, calls } = makeDeps(false);

    await expect(restartLocalDaemon(deps)).resolves.toBe(false);
    expect(calls).toEqual(["stop", "start"]);
  });

  it("reports a throwing stop and never starts on top of it", async () => {
    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { modelId: "qwen-3.5-4b" },
    });
    resetConfigCache();
    const { deps, emitted, startDaemon } = makeDeps();
    deps.stopChatDaemonOnly = async () => {
      throw new Error("foreign daemon: not ours to signal");
    };

    await expect(restartLocalDaemon(deps)).resolves.toBe(false);

    expect(startDaemon).not.toHaveBeenCalled();
    const err = emitted.find((a) => a.type === "local_models_daemon_error_set");
    expect(err?.message).toContain("foreign daemon");
    expect(
      lines(emitted).some((l) => l.includes("restart failed — foreign daemon")),
    ).toBe(true);
  });

  it("external mode: names the URL and touches nothing", async () => {
    persistUserLocalModelsConfig({
      mode: "external",
      url: "http://127.0.0.1:19555",
    });
    resetConfigCache();
    const { deps, emitted, stopChatDaemonOnly, startDaemon } = makeDeps();

    await expect(restartLocalDaemon(deps)).resolves.toBe(false);

    expect(stopChatDaemonOnly).not.toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
    const line = lines(emitted).find((l) => l.includes("external mode"));
    expect(line).toContain("http://127.0.0.1:19555");
    expect(line).toContain("restart that llama-server yourself");
  });

  it("a live cloud route: says so and points at /llm check", async () => {
    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { modelId: "qwen-3.5-4b" },
    });
    resetConfigCache();
    persistLlmProvider({
      id: "openrouter",
      kind: "openrouter",
      apiKey: "sk-test",
      defaultChatModel: "qwen/qwen3.6-plus",
    });
    setActiveTextProviderInConfig("openrouter");
    resetConfigCache();
    const { deps, emitted, stopChatDaemonOnly, startDaemon } = makeDeps();

    await expect(restartLocalDaemon(deps)).resolves.toBe(false);

    expect(stopChatDaemonOnly).not.toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
    const line = lines(emitted).find((l) => l.includes("nothing"));
    expect(line).toContain('"openrouter"');
    expect(line).toContain("/llm check");
  });
});

/**
 * The wiring end: `LocalModelsOrchestrator.restartDaemon` must reach the
 * chat-only stop. `stopDaemon` — the `s` toggle's stop — also calls
 * `stopChatAndEmbeddingDaemons` and `persistMemoryEmbeddingsEnabled(false)`,
 * so a restart routed through it would silently turn hybrid recall off.
 */
describe("LocalModelsOrchestrator.restartDaemon", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-restart-orch-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { modelId: "qwen-3.5-4b" },
    });
    resetConfigCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("delegates to the chat-only stop and never to the embedding-stopping one", async () => {
    const orchestrator = new LocalModelsOrchestrator({
      emit: () => {},
      subscribe: () => () => {},
    });
    const order: string[] = [];
    const stopChatOnly = vi
      .spyOn(orchestrator, "stopChatDaemonOnly")
      .mockImplementation(async () => {
        order.push("stop");
      });
    const stopBoth = vi.spyOn(orchestrator, "stopDaemon").mockResolvedValue();
    const start = vi
      .spyOn(orchestrator, "startDaemon")
      .mockImplementation(async () => {
        order.push("start");
        return true;
      });

    await expect(orchestrator.restartDaemon()).resolves.toBe(true);

    expect(order).toEqual(["stop", "start"]);
    expect(stopChatOnly).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stopBoth).not.toHaveBeenCalled();
  });
});
