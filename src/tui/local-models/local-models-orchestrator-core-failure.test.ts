import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../local-llm/index.js", async () => ({
  ...(await vi.importActual<typeof import("../../local-llm/index.js")>("../../local-llm/index.js")),
  // Never the network: the install outcome is what is under test.
  downloadBackend: vi.fn(),
}));

import { getConfig, resetConfigCache } from "../../config/index.js";
import { downloadBackend } from "../../local-llm/index.js";
import { CORE_FALLBACK_LINE, CoreUnavailableError } from "../../local-llm/core/core-errors.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

type Emitted = { type: string; failure?: unknown; line?: string };
let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "local-models-core-failure-"));
  process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
  resetConfigCache();
  vi.mocked(downloadBackend).mockReset();
});
afterEach(() => {
  delete process.env.ATOMIC_AGENT_STATE_DIR;
  resetConfigCache();
  rmSync(stateDir, { recursive: true, force: true });
});

function orchestrator() {
  const emitted: Emitted[] = [];
  const onLocalEngineFailed = vi.fn();
  const o = new LocalModelsOrchestrator({ emit: (a: unknown) => { emitted.push(a as Emitted); }, subscribe: () => () => {} }, { onLocalEngineFailed });
  vi.spyOn(o as unknown as { refresh: () => Promise<void> }, "refresh").mockResolvedValue();
  return { o, emitted, onLocalEngineFailed };
}

it("turns a failed Atomic Core install into the panel notice, a feed line and a report", async () => {
  vi.mocked(downloadBackend).mockRejectedValue(new CoreUnavailableError({ stage: "download", reasonCode: "network", detail: "fetch failed" }));
  const { o, emitted, onLocalEngineFailed } = orchestrator();
  await o.pullBackend();
  const set = emitted.filter(a => a.type === "local_models_core_failure_set");
  expect(set.at(0)?.failure).toBeNull();
  expect(set.at(-1)?.failure).toMatchObject({ stage: "download", reasonCode: "network", retryable: true });
  expect(emitted.some(a => a.type === "runtime_info" && a.line?.includes("Press R in Models"))).toBe(true);
  expect(onLocalEngineFailed).toHaveBeenCalledWith(expect.objectContaining({ stage: "download", reasonCode: "network" }));
});

it("does not raise the notice for an ordinary failure or a cancellation", async () => {
  vi.mocked(downloadBackend).mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
  const { o, emitted, onLocalEngineFailed } = orchestrator();
  await o.pullBackend();
  expect(emitted.filter(a => a.type === "local_models_core_failure_set").every(a => a.failure === null)).toBe(true);
  expect(onLocalEngineFailed).not.toHaveBeenCalled();
});

it("switches a computer without a Core build to llama.cpp once, instead of offering download again", async () => {
  vi.mocked(downloadBackend).mockRejectedValue(new CoreUnavailableError({ stage: "backend", reasonCode: "no_backend", detail: "Atomic Core found no compatible inference backend for this computer" }));
  const { o, emitted, onLocalEngineFailed } = orchestrator();
  expect(getConfig().localModels.managed.engine).toBe("atomic-core");
  await o.pullBackend();
  // Reported once, as local_engine_failed, before the switch.
  expect(onLocalEngineFailed).toHaveBeenCalledTimes(1);
  expect(onLocalEngineFailed).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: "no_backend", retryable: false }));
  expect(emitted.some(a => a.type === "runtime_info" && a.line?.includes(CORE_FALLBACK_LINE))).toBe(true);
  expect(emitted.some(a => a.type === "runtime_info" && a.line?.includes("Press R in Models"))).toBe(false);
  expect(emitted.filter(a => a.type === "local_models_core_failure_set").every(a => a.failure === null)).toBe(true);
  resetConfigCache();
  expect(getConfig().localModels.managed.engine).toBe("llama-server");
});
