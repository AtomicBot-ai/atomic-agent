import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";

import { reduceTuiState } from "../agent-event-reducer.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiSessionInfo, type TuiState } from "../tui-state.js";
import { handleLocalModelsTabKey } from "./local-models-key-bindings.js";
import { showsCoreFailureNotice, type LocalModelsCoreFailure } from "./local-models-panel-state.js";

const SESSION: TuiSessionInfo = {
  sessionId: null,
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: true,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};
const FAILURE: LocalModelsCoreFailure = {
  stage: "download",
  reasonCode: "network",
  reason: "The Atomic Chat engine could not be downloaded: fetch failed.",
  retryable: true,
};
const KEY = { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false } as Key;

function modelsTab(engine: "atomic-core" | "llama-server" = "atomic-core"): TuiState {
  const initial = createInitialTuiState(SESSION);
  const state: TuiState = { ...initial, uiMode: "debug", activeTab: "models" };
  return { ...state, localModelsPanel: { ...state.localModelsPanel, backend: { ...state.localModelsPanel.backend, engine } } };
}
function snapshot(state: TuiState, engine: "atomic-core" | "llama-server"): TuiState {
  const p = state.localModelsPanel;
  return reduceTuiState(state, {
    type: "local_models_snapshot_loaded", rows: p.rows, backend: { ...p.backend, engine }, daemon: p.daemon,
    configMode: "managed", activeModelId: null, totalRamGb: null, gpuBudgetGb: null, dataDir: null,
    embeddingRows: [], embeddingDaemon: null, at: 1,
  } as TuiAction);
}

describe("Atomic Core failure notice", () => {
  it("is set by a failure, kept across Core snapshots and cleared by switching to llama.cpp", () => {
    let state = reduceTuiState(modelsTab(), { type: "local_models_core_failure_set", failure: FAILURE });
    expect(state.localModelsPanel.coreFailure).toEqual(FAILURE);
    expect(showsCoreFailureNotice(state.localModelsPanel)).toBe(true);
    state = snapshot(state, "atomic-core");
    expect(state.localModelsPanel.coreFailure).toEqual(FAILURE);
    state = snapshot(state, "llama-server");
    expect(state.localModelsPanel.coreFailure).toBeNull();
    state = reduceTuiState(modelsTab(), { type: "local_models_core_failure_set", failure: null });
    expect(showsCoreFailureNotice(state.localModelsPanel)).toBe(false);
  });

  it("R downloads again while the notice shows, and L still opens the logs tab", () => {
    const state = reduceTuiState(modelsTab(), { type: "local_models_core_failure_set", failure: FAILURE });
    const callbacks = { onLocalModelsCoreRetryRequested: vi.fn(), onLocalModelsEngineRequested: vi.fn() } as unknown as TuiAppCallbacks;
    const dispatch = vi.fn();
    expect(handleLocalModelsTabKey("R", KEY, { state, dispatch, callbacks })).toBe(true);
    expect(callbacks.onLocalModelsCoreRetryRequested).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(handleLocalModelsTabKey("L", KEY, { state, dispatch, callbacks })).toBe(true);
    expect(callbacks.onLocalModelsEngineRequested).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: "tab_changed", tab: "llm-logs" });
  });

  it("leaves L on the logs tab when there is no notice", () => {
    const callbacks = { onLocalModelsEngineRequested: vi.fn() } as unknown as TuiAppCallbacks;
    const dispatch = vi.fn();
    expect(handleLocalModelsTabKey("L", KEY, { state: modelsTab(), dispatch, callbacks })).toBe(true);
    expect(callbacks.onLocalModelsEngineRequested).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: "tab_changed", tab: "llm-logs" });
  });
});
