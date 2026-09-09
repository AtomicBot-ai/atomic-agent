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

  function makeDeps(
    startResult = true,
    stopResult = true,
  ): {
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
      return stopResult;
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

  it("refuses to start on top of a stop that failed", async () => {
    // The real `stopChatDaemonOnly` does not throw — it reports the
    // failure and resolves false. Starting anyway would spawn a second
    // `llama-server`: `daemon-lifecycle.startDaemon`'s pid-file guard is
    // read a whole preflight before the file is written, so the survivor
    // and the newcomer both get one, and only the last is addressable.
    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { modelId: "qwen-3.5-4b" },
    });
    resetConfigCache();
    const { deps, emitted, calls, startDaemon } = makeDeps(true, false);

    await expect(restartLocalDaemon(deps)).resolves.toBe(false);

    expect(calls).toEqual(["stop"]);
    expect(startDaemon).not.toHaveBeenCalled();
    expect(
      lines(emitted).some((l) => l.includes("restart aborted")),
    ).toBe(true);
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
        return true;
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

  it("does not narrate the stop as a switch to an external server", () => {
    // `stopChatDaemonOnly`'s default line was written for the one caller
    // it had — saving an external URL. Mid-restart it claims a server
    // that is not in play, one line before "starting …" contradicts it.
    const emitted: Array<{ type: string; line?: string }> = [];
    const orchestrator = new LocalModelsOrchestrator({
      emit: (a) => emitted.push(a as never),
      subscribe: () => () => {},
    });
    let stoppedLine: string | undefined;
    vi.spyOn(orchestrator, "stopChatDaemonOnly").mockImplementation(
      async (opts) => {
        stoppedLine = opts?.stoppedLine;
        return true;
      },
    );
    vi.spyOn(orchestrator, "startDaemon").mockResolvedValue(true);

    void orchestrator.restartDaemon();

    expect(stoppedLine).toBeDefined();
    expect(stoppedLine).not.toContain("external URL");
  });

  it("coalesces a double `R` onto one restart instead of two spawns", async () => {
    // Two restarts in flight both clear the pid file on their stop and
    // both find it empty at the top of `startDaemon` — the guard there
    // is read a backend-update-and-device-probe before the file is
    // written. Both spawn; the second overwrites the pid file, and the
    // first `llama-server` is orphaned holding the port and the VRAM,
    // unreachable by every TUI stop from then on.
    const orchestrator = new LocalModelsOrchestrator({
      emit: () => {},
      subscribe: () => () => {},
    });
    const stop = vi
      .spyOn(orchestrator, "stopChatDaemonOnly")
      .mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return true;
      });
    const start = vi
      .spyOn(orchestrator, "startDaemon")
      .mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return true;
      });

    const first = orchestrator.restartDaemon();
    const second = orchestrator.restartDaemon();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);

    // The guard is per-restart, not a latch: the next `R` still works.
    await expect(orchestrator.restartDaemon()).resolves.toBe(true);
    expect(start).toHaveBeenCalledTimes(2);
  });
});
