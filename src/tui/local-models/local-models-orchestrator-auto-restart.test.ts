import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetConfigCache } from "../../config/index.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

type Internals = {
  daemonSupervised: boolean;
  supervisor: { tick(): Promise<void>; noteStarted(): void; start(): void; stop(): void; timer: unknown };
};

/**
 * The supervisor wiring inside the orchestrator: which daemon it owns,
 * which config switches it, and which restart it runs. The pid file is
 * never written, so the daemon always reads as dead.
 */
describe("LocalModelsOrchestrator auto-restart", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-autorestart-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    persistUserLocalModelsConfig({ mode: "managed", managed: { modelId: "qwen-3.5-4b" } });
  });

  const built: Internals[] = [];

  afterEach(() => {
    for (const inner of built.splice(0)) inner.supervisor.stop();
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function build() {
    const lines: string[] = [];
    const orchestrator = new LocalModelsOrchestrator({
      emit(a: unknown) {
        const line = (a as { line?: string }).line;
        if (line) lines.push(line);
      },
      subscribe: () => () => {},
    });
    const stop = vi.spyOn(orchestrator, "stopChatDaemonOnly").mockResolvedValue(true);
    const start = vi.spyOn(orchestrator, "startDaemon").mockResolvedValue(true);
    const inner = orchestrator as unknown as Internals;
    built.push(inner);
    return { orchestrator, inner, stop, start, lines };
  }

  it("restarts a dead daemon it owns: stop what is left, then start", async () => {
    const { inner, stop, start, lines } = build();
    inner.daemonSupervised = true;
    await inner.supervisor.tick();
    await inner.supervisor.tick();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop.mock.invocationCallOrder[0]!).toBeLessThan(start.mock.invocationCallOrder[0]!);
    expect(lines).toContain("local-llm: the model server died — restarting it (auto-restart)");
  });

  it("taking ownership arms the supervisor's timer — no LLM pane needed", () => {
    const { inner } = build();
    expect(inner.supervisor.timer).toBeNull();
    inner.daemonSupervised = true;
    expect(inner.supervisor.timer).not.toBeNull();
  });

  it("leaves a daemon it does not own alone", async () => {
    const { inner, start } = build();
    inner.daemonSupervised = false;
    for (let i = 0; i < 4; i += 1) await inner.supervisor.tick();
    expect(start).not.toHaveBeenCalled();
  });

  it("localModels.managed.autoRestart: false turns it off", async () => {
    persistUserLocalModelsConfig({ managed: { autoRestart: false } });
    const { inner, start } = build();
    inner.daemonSupervised = true;
    for (let i = 0; i < 4; i += 1) await inner.supervisor.tick();
    expect(start).not.toHaveBeenCalled();
  });

  it("does not depend on the local route being active (Fusion workers, the fallback link)", async () => {
    const { orchestrator, inner, start } = build();
    const restartByHand = vi.spyOn(orchestrator, "restartDaemon");
    inner.daemonSupervised = true;
    await inner.supervisor.tick();
    await inner.supervisor.tick();
    expect(start).toHaveBeenCalledTimes(1);
    // Not `/llm restart`'s path, which refuses on a cloud route.
    expect(restartByHand).not.toHaveBeenCalled();
  });
});
