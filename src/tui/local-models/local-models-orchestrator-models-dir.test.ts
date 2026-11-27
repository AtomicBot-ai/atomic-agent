import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetConfigCache } from "../../config/index.js";
import type { ModelsDirDeps } from "../../cli/models-dir-command.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

type Internals = {
  supervisor: { stop(): void; deps: { enabled(): boolean } };
  stopChatDaemonOnlyNow: () => Promise<boolean>;
  refresh: () => Promise<void>;
};

/**
 * ATO-2504: the models folder move on a real LocalModelsOrchestrator and
 * its real ModelOperationQueue. Model operations queue behind the move and
 * the supervisor holds off, but the move is no blocking switch: a chat turn
 * on a cloud model (which waits on `isSwitching` / `waitForSwitch`) is not
 * held up for the length of the copy.
 */
describe("LocalModelsOrchestrator models folder move", () => {
  let stateDir: string;
  const built: Internals[] = [];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-models-dir-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    for (const inner of built.splice(0)) inner.supervisor.stop();
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function build() {
    const orchestrator = new LocalModelsOrchestrator({ emit() {}, subscribe: () => () => {} });
    const inner = orchestrator as unknown as Internals;
    built.push(inner);
    vi.spyOn(inner, "refresh").mockResolvedValue();
    let finish: (code: number) => void = () => {};
    let started: () => void = () => {};
    const running = new Promise<void>((r) => { started = r; });
    // The command itself: held open until the test lets it finish.
    const run = (args: readonly string[], _deps: ModelsDirDeps): Promise<number> => {
      if (args[0] === "--json") return Promise.resolve(1);
      started();
      return new Promise<number>((r) => { finish = r; });
    };
    (orchestrator.modelsDir as unknown as { deps: { run: typeof run } }).deps.run = run;
    return { orchestrator, inner, running, finish: (code: number) => finish(code) };
  }

  it("does not count as a model switch, so a cloud chat turn does not wait for the copy", async () => {
    const { orchestrator, running, finish } = build();
    const move = orchestrator.modelsDir.move("/Volumes/USB/models");
    await running;
    expect(orchestrator.modelsDir.moving).toBe(true);
    expect(orchestrator.isSwitching).toBe(false);
    let waited = false;
    await orchestrator.waitForSwitch(new AbortController().signal).then(() => { waited = true; });
    expect(waited).toBe(true);
    finish(0);
    await move;
    expect(orchestrator.modelsDir.moving).toBe(false);
  });

  it("queues a model operation behind the move on the real queue", async () => {
    const { orchestrator, inner, running, finish } = build();
    const stopNow = vi.spyOn(inner, "stopChatDaemonOnlyNow").mockResolvedValue(true);
    const move = orchestrator.modelsDir.move("/Volumes/USB/models");
    await running;
    const stop = orchestrator.stopChatDaemonOnly();
    await new Promise((r) => setTimeout(r, 10));
    expect(stopNow).not.toHaveBeenCalled();
    finish(0);
    await move;
    await expect(stop).resolves.toBe(true);
    expect(stopNow).toHaveBeenCalledTimes(1);
  });

  it("keeps the supervisor from restarting anything while the move runs", async () => {
    persistUserLocalModelsConfig({ mode: "managed", managed: { modelId: "qwen-3.5-4b", autoRestart: true } });
    const { orchestrator, inner, running, finish } = build();
    expect(inner.supervisor.deps.enabled()).toBe(true);
    const move = orchestrator.modelsDir.move("/Volumes/USB/models");
    await running;
    expect(inner.supervisor.deps.enabled()).toBe(false);
    finish(0);
    await move;
    expect(inner.supervisor.deps.enabled()).toBe(true);
  });
});
