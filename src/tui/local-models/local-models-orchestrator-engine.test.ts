import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../local-llm/engine-selection.js", () => ({
  // The real guard probes ports and takes the engine lock; only its persist step matters here.
  selectManagedEngine: vi.fn(async (_dir: string, _chat: number, _emb: number, persist: () => void) => persist()),
}));
vi.mock("../persist-user-local-models-config.js", () => ({ persistUserLocalModelsConfig: vi.fn() }));

import { resetConfigCache } from "../../config/index.js";
import { ATOMIC_CORE_EXPERIMENTAL_ENV } from "../../local-llm/core/experimental.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "local-models-engine-"));
  process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
  // The queue tests choose Atomic Chat, which is offered only on opt-in.
  process.env[ATOMIC_CORE_EXPERIMENTAL_ENV] = "1";
  resetConfigCache();
  vi.mocked(persistUserLocalModelsConfig).mockReset();
});
afterEach(() => {
  delete process.env.ATOMIC_AGENT_STATE_DIR;
  delete process.env[ATOMIC_CORE_EXPERIMENTAL_ENV];
  resetConfigCache();
  rmSync(stateDir, { recursive: true, force: true });
});

function orchestratorWithSlowStart() {
  const orchestrator = new LocalModelsOrchestrator({ emit() {}, subscribe: () => () => {} });
  const internals = orchestrator as unknown as {
    startDaemonNow: () => Promise<boolean>; stopDaemonNow: () => Promise<void>; refresh: () => Promise<void>;
  };
  // The queue starts the load on a later tick; an outcome given before that is handed over when it does.
  let resolveStart: ((ok: boolean) => void) | undefined;
  let earlyOutcome: boolean | undefined;
  vi.spyOn(internals, "startDaemonNow").mockImplementation(() => new Promise(resolve => {
    if (earlyOutcome === undefined) resolveStart = resolve; else resolve(earlyOutcome);
  }));
  vi.spyOn(internals, "stopDaemonNow").mockResolvedValue();
  vi.spyOn(internals, "refresh").mockResolvedValue();
  const finishStart = (ok: boolean) => { if (resolveStart) resolveStart(ok); else earlyOutcome = ok; };
  return { orchestrator, finishStart };
}

it("saves an engine choice queued behind a loading model once the load ends", async () => {
  const { orchestrator, finishStart } = orchestratorWithSlowStart();
  const starting = orchestrator.startDaemon();
  const choosing = orchestrator.chooseEngine("atomic-core");
  await Promise.resolve();
  finishStart(true);
  await starting;
  await expect(choosing).resolves.toBe(true);
  expect(persistUserLocalModelsConfig).toHaveBeenCalledWith({ managed: { engine: "atomic-core" } });
});

it("Stop cancels an engine choice still queued behind the load it stops", async () => {
  const { orchestrator, finishStart } = orchestratorWithSlowStart();
  const starting = orchestrator.startDaemon();
  const choosing = orchestrator.chooseEngine("atomic-core");
  const stopping = orchestrator.stopDaemon();
  finishStart(false);
  await Promise.all([starting, stopping]);
  await expect(choosing).resolves.toBe(false);
  expect(persistUserLocalModelsConfig).not.toHaveBeenCalled();
});

it("refuses Atomic Chat without the opt-in and still switches back to llama.cpp", async () => {
  delete process.env[ATOMIC_CORE_EXPERIMENTAL_ENV];
  const emitted: Array<{ type: string; text?: string }> = [];
  const orchestrator = new LocalModelsOrchestrator({ emit: (a: unknown) => { emitted.push(a as { type: string; text?: string }); }, subscribe: () => () => {} });
  vi.spyOn(orchestrator as unknown as { refresh: () => Promise<void> }, "refresh").mockResolvedValue();
  await expect(orchestrator.chooseEngine("atomic-core")).resolves.toBe(false);
  expect(persistUserLocalModelsConfig).not.toHaveBeenCalled();
  expect(emitted.some(a => a.type === "composer_notice" && a.text?.includes(ATOMIC_CORE_EXPERIMENTAL_ENV))).toBe(true);
  await expect(orchestrator.chooseEngine("llama-server")).resolves.toBe(true);
});
