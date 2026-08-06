import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";

import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import { reduceProvidersPanel } from "./providers-reducer.js";
import type { ProvidersChatModelPickerState } from "./providers-panel-state.js";
import { handleLlmModalKey } from "../llm-panel/llm-panel-modal-key-bindings.js";

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

function stateWithPicker(
  picker: ProvidersChatModelPickerState | null,
): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    uiMode: "debug" as const,
    activeTab: "llm" as const,
    llmPanel: { ...base.llmPanel, mode: "cloud" as const },
    providersPanel: {
      ...base.providersPanel,
      chatModelPicker: picker,
      chatModelPickerGeneration: picker?.generation ?? 0,
    },
  };
}

function readyPicker(
  overrides: Partial<ProvidersChatModelPickerState> = {},
): ProvidersChatModelPickerState {
  return {
    providerId: "my-vllm",
    currentModelId: "qwen-32b",
    status: "ready",
    models: ["glm-9b", "qwen-32b", "yi-34b"],
    cursor: 1,
    error: null,
    generation: 1,
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
    const next = reduceProvidersPanel(state, {
      type: "providers_chat_model_picker_opened",
      providerId: "my-vllm",
      currentModelId: "qwen-32b",
      generation: 1,
    });
    expect(next.providersPanel.chatModelPicker).toMatchObject({
      providerId: "my-vllm",
      status: "loading",
      models: [],
    });
  });

  it("loaded → ready with the cursor on the current model", () => {
    const state = stateWithPicker(
      readyPicker({ status: "loading", models: [], cursor: 0 }),
    );
    const next = reduceProvidersPanel(state, {
      type: "providers_chat_model_picker_loaded",
      generation: 1,
      models: ["glm-9b", "qwen-32b", "yi-34b"],
    });
    expect(next.providersPanel.chatModelPicker).toMatchObject({
      status: "ready",
      cursor: 1,
    });
  });

  it("a response from an older generation is ignored", () => {
    // Esc, then reopen for the SAME provider: the first fetch settles
    // late and must not repopulate the second picker.
    const state = stateWithPicker(
      readyPicker({ status: "loading", models: [], generation: 2 }),
    );
    const next = reduceProvidersPanel(state, {
      type: "providers_chat_model_picker_loaded",
      generation: 1,
      models: ["stale-model"],
    });
    expect(next.providersPanel.chatModelPicker?.status).toBe("loading");
    expect(next.providersPanel.chatModelPicker?.models).toEqual([]);
  });

  it("loaded after close does not resurrect the modal", () => {
    const state = stateWithPicker(null);
    const next = reduceProvidersPanel(state, {
      type: "providers_chat_model_picker_loaded",
      generation: 1,
      models: ["a"],
    });
    expect(next.providersPanel.chatModelPicker).toBeNull();
  });

  it("failed → error state", () => {
    const state = stateWithPicker(readyPicker({ status: "loading" }));
    const next = reduceProvidersPanel(state, {
      type: "providers_chat_model_picker_failed",
      generation: 1,
      error: "http 401",
    });
    expect(next.providersPanel.chatModelPicker).toMatchObject({
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
    expect(dispatched).toEqual([{ type: "providers_chat_model_picker_cursor_set", cursor: 0 }]);
  });

  it("Enter selects the model under the cursor, closes, and routes the switch", () => {
    const onProvidersSelectChatModel = vi.fn();
    const { dispatched } = pressModal(
      "",
      emptyKey({ return: true }),
      stateWithPicker(readyPicker({ cursor: 2 })),
      callbacks({ onProvidersSelectChatModel }),
    );
    expect(dispatched).toEqual([{ type: "providers_chat_model_picker_closed" }]);
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
    expect(dispatched).toEqual([{ type: "providers_chat_model_picker_closed" }]);
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
    expect(dispatched).toEqual([{ type: "providers_chat_model_picker_closed" }]);
  });
});
