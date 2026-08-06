import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";

import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import { handleLlmModalKey } from "./llm-panel-modal-key-bindings.js";
import { reduceLlmPanelAction } from "./llm-panel-reducer.js";
import type { LlmModelPickerState } from "./llm-panel-state.js";

function emptyKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  };
}

function callbacks(overrides: Partial<TuiAppCallbacks> = {}): TuiAppCallbacks {
  return {
    onApprovalDecision: vi.fn(),
    onAbort: vi.fn(),
    onQuit: vi.fn(),
    onMessageSubmitted: vi.fn(),
    ...overrides,
  };
}

function stateWithPicker(picker: LlmModelPickerState | null): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    uiMode: "debug" as const,
    activeTab: "llm" as const,
    llmPanel: { ...base.llmPanel, mode: "cloud" as const, modelPicker: picker },
  };
}

function readyPicker(overrides: Partial<LlmModelPickerState> = {}): LlmModelPickerState {
  return {
    providerId: "my-vllm",
    currentModelId: "qwen-32b",
    status: "ready",
    models: ["glm-9b", "qwen-32b", "yi-34b"],
    cursor: 1,
    error: null,
    ...overrides,
  };
}

function pressModal(
  input: string,
  key: Key,
  state: TuiState,
  cbs: TuiAppCallbacks = callbacks(),
): { dispatched: TuiAction[]; handled: boolean | null } {
  const dispatched: TuiAction[] = [];
  const handled = handleLlmModalKey(input, key, {
    state,
    dispatch: (a) => dispatched.push(a),
    callbacks: cbs,
  });
  return { dispatched, handled };
}

describe("model picker reducer", () => {
  it("opened → loading state for the provider", () => {
    const state = stateWithPicker(null);
    const next = reduceLlmPanelAction(state, {
      type: "llm_model_picker_opened",
      providerId: "my-vllm",
      currentModelId: "qwen-32b",
    });
    expect(next.llmPanel.modelPicker).toMatchObject({
      providerId: "my-vllm",
      status: "loading",
      models: [],
    });
  });

  it("loaded → ready with the cursor on the current model", () => {
    const state = stateWithPicker(
      readyPicker({ status: "loading", models: [], cursor: 0 }),
    );
    const next = reduceLlmPanelAction(state, {
      type: "llm_model_picker_loaded",
      providerId: "my-vllm",
      models: ["glm-9b", "qwen-32b", "yi-34b"],
    });
    expect(next.llmPanel.modelPicker).toMatchObject({
      status: "ready",
      cursor: 1,
    });
  });

  it("stale loaded for another provider is ignored", () => {
    const state = stateWithPicker(
      readyPicker({ providerId: "other", status: "loading" }),
    );
    const next = reduceLlmPanelAction(state, {
      type: "llm_model_picker_loaded",
      providerId: "my-vllm",
      models: ["a"],
    });
    expect(next.llmPanel.modelPicker?.status).toBe("loading");
  });

  it("loaded after close does not resurrect the modal", () => {
    const state = stateWithPicker(null);
    const next = reduceLlmPanelAction(state, {
      type: "llm_model_picker_loaded",
      providerId: "my-vllm",
      models: ["a"],
    });
    expect(next.llmPanel.modelPicker).toBeNull();
  });

  it("failed → error state", () => {
    const state = stateWithPicker(readyPicker({ status: "loading" }));
    const next = reduceLlmPanelAction(state, {
      type: "llm_model_picker_failed",
      providerId: "my-vllm",
      error: "http 401",
    });
    expect(next.llmPanel.modelPicker).toMatchObject({
      status: "error",
      error: "http 401",
    });
  });
});

describe("model picker modal keys", () => {
  it("arrows move the cursor with wrap-around", () => {
    const { dispatched } = pressModal(
      "",
      emptyKey({ downArrow: true }),
      stateWithPicker(readyPicker({ cursor: 2 })),
    );
    expect(dispatched).toEqual([{ type: "llm_model_picker_cursor_set", cursor: 0 }]);
  });

  it("Enter selects the model under the cursor, closes, and routes the switch", () => {
    const onProvidersSelectChatModel = vi.fn();
    const { dispatched } = pressModal(
      "",
      emptyKey({ return: true }),
      stateWithPicker(readyPicker({ cursor: 2 })),
      callbacks({ onProvidersSelectChatModel }),
    );
    expect(dispatched).toEqual([{ type: "llm_model_picker_closed" }]);
    expect(onProvidersSelectChatModel).toHaveBeenCalledWith("my-vllm", "yi-34b");
  });

  it("Esc closes without selecting", () => {
    const onProvidersSelectChatModel = vi.fn();
    const { dispatched } = pressModal(
      "",
      emptyKey({ escape: true }),
      stateWithPicker(readyPicker()),
      callbacks({ onProvidersSelectChatModel }),
    );
    expect(dispatched).toEqual([{ type: "llm_model_picker_closed" }]);
    expect(onProvidersSelectChatModel).not.toHaveBeenCalled();
  });

  it("loading state swallows keys so the panel underneath stays inert", () => {
    const { dispatched, handled } = pressModal(
      "x",
      emptyKey(),
      stateWithPicker(readyPicker({ status: "loading", models: [] })),
    );
    expect(handled).toBe(true);
    expect(dispatched).toEqual([]);
  });

  it("Enter on the error state closes the modal", () => {
    const { dispatched } = pressModal(
      "",
      emptyKey({ return: true }),
      stateWithPicker(readyPicker({ status: "error", error: "http 500" })),
    );
    expect(dispatched).toEqual([{ type: "llm_model_picker_closed" }]);
  });
});
