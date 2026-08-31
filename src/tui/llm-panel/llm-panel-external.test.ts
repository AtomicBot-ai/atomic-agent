import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import { handleLlmPanelKey } from "./llm-panel-key-bindings.js";
import { reduceLlmPanelAction } from "./llm-panel-reducer.js";
import { selectLlmPanelRows } from "./llm-panel-selectors.js";

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

function externalState(overrides: Partial<TuiState> = {}): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    uiMode: "debug" as const,
    activeTab: "llm" as const,
    session: { ...base.session, llamaUrl: "http://127.0.0.1:8080" },
    llmPanel: { ...base.llmPanel, mode: "external" as const },
    ...overrides,
  };
}

/** Feed a key through the panel, returning what it dispatched. */
function press(
  input: string,
  key: Key,
  state: TuiState,
  cbs: TuiAppCallbacks = callbacks(),
): TuiAction[] {
  const dispatched: TuiAction[] = [];
  handleLlmPanelKey(input, key, {
    state,
    dispatch: (action) => dispatched.push(action),
    callbacks: cbs,
  });
  return dispatched;
}

describe("external llama.cpp pane", () => {
  it("cycles Local → Cloud → External → Fallback → Local with →", () => {
    let state = createInitialTuiState(fakeSession());
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const [action] = press("]", emptyKey(), {
        ...state,
        uiMode: "debug",
        activeTab: "llm",
      });
      state = reduceLlmPanelAction(state, action!) ?? state;
      seen.push(state.llmPanel.mode);
    }
    expect(seen).toEqual(["cloud", "external", "fallback", "local"]);
  });

  it("steps backwards with ← (wraps to the last pane, Fallback)", () => {
    const state = createInitialTuiState(fakeSession());
    const [action] = press(
      "",
      emptyKey({ leftArrow: true }),
      { ...state, uiMode: "debug", activeTab: "llm" },
    );
    expect(action).toEqual({ type: "llm_mode_set", mode: "fallback" });
  });

  it("shows the configured URL and reports inactive while managed mode is on", () => {
    const rows = selectLlmPanelRows(externalState(), "external");
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "externalUrl",
        url: "http://127.0.0.1:8080",
        active: false,
      }),
    ]);
  });

  it("marks the row active once the route runs on an external URL", () => {
    const base = externalState();
    const rows = selectLlmPanelRows(
      {
        ...base,
        localModelsPanel: { ...base.localModelsPanel, configMode: "external" },
        providersPanel: {
          ...base.providersPanel,
          rows: [
            {
              id: "local-llama",
              kind: "llama-server",
              isActiveText: true,
              isActiveEmbedding: false,
              hasApiKey: false,
              chatModel: "Qwen",
              embeddingModel: null,
            },
          ],
        },
      },
      "external",
    );
    expect(rows[0]).toMatchObject({ active: true, primaryAction: "current" });
  });

  it("Enter opens the URL editor seeded with the current URL", () => {
    expect(press("", emptyKey({ return: true }), externalState())).toEqual([
      { type: "llm_external_url_draft_set", value: "http://127.0.0.1:8080" },
    ]);
  });

  it("types into the editor instead of firing panel hotkeys", () => {
    const state = externalState();
    state.llmPanel = { ...state.llmPanel, externalUrlDraft: "http://box" };
    // `s` is the daemon start/stop hotkey outside the modal.
    const onStop = vi.fn();
    const dispatched = press(
      "s",
      emptyKey(),
      state,
      callbacks({ onLocalModelsDaemonStopRequested: onStop }),
    );
    expect(dispatched).toEqual([
      { type: "llm_external_url_draft_set", value: "http://boxs" },
    ]);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("persists a scheme-less URL on Enter and closes the editor", () => {
    const state = externalState();
    state.llmPanel = { ...state.llmPanel, externalUrlDraft: "192.168.1.50:8080" };
    const onPersist = vi.fn();
    const dispatched = press(
      "",
      emptyKey({ return: true }),
      state,
      callbacks({ onPersistLlamaUrl: onPersist }),
    );
    expect(dispatched).toEqual([{ type: "llm_external_url_draft_set", value: null }]);
    expect(onPersist).toHaveBeenCalledWith("http://192.168.1.50:8080");
  });

  it("keeps the editor open and persists nothing when the URL is unparseable", () => {
    const state = externalState();
    state.llmPanel = { ...state.llmPanel, externalUrlDraft: "  " };
    const onPersist = vi.fn();
    const dispatched = press(
      "",
      emptyKey({ return: true }),
      state,
      callbacks({ onPersistLlamaUrl: onPersist }),
    );
    expect(dispatched).toEqual([]);
    expect(onPersist).not.toHaveBeenCalled();
  });

  it("Esc closes the editor without persisting", () => {
    const state = externalState();
    state.llmPanel = { ...state.llmPanel, externalUrlDraft: "http://box" };
    const onPersist = vi.fn();
    const dispatched = press(
      "",
      emptyKey({ escape: true }),
      state,
      callbacks({ onPersistLlamaUrl: onPersist }),
    );
    expect(dispatched).toEqual([{ type: "llm_external_url_draft_set", value: null }]);
    expect(onPersist).not.toHaveBeenCalled();
  });

  it("keeps a per-pane cursor", () => {
    const state = externalState();
    const next = reduceLlmPanelAction(state, {
      type: "llm_cursor_set",
      cursor: 3,
      mode: "external",
    });
    expect(next?.llmPanel.externalCursor).toBe(3);
    expect(next?.llmPanel.localCursor).toBe(state.llmPanel.localCursor);
  });
});

describe("openai-compat steer prompt", () => {
  function steerState(url = "http://127.0.0.1:11434"): TuiState {
    const state = externalState();
    state.llmPanel = { ...state.llmPanel, externalCompatSteerUrl: url };
    return state;
  }

  it("opens on the openai-compat verdict action and closes again", () => {
    const opened = reduceLlmPanelAction(externalState(), {
      type: "llm_external_compat_steer_opened",
      url: "http://127.0.0.1:11434",
    });
    expect(opened?.llmPanel.externalCompatSteerUrl).toBe(
      "http://127.0.0.1:11434",
    );
    const closed = reduceLlmPanelAction(opened!, {
      type: "llm_external_compat_steer_closed",
    });
    expect(closed?.llmPanel.externalCompatSteerUrl).toBeNull();
  });

  it("y opens the provider wizard on the Ollama preset with the probed URL", () => {
    const dispatched = press("y", emptyKey(), steerState());
    expect(dispatched[0]).toEqual({ type: "llm_external_compat_steer_closed" });
    expect(dispatched[1]).toEqual({ type: "llm_mode_set", mode: "cloud" });
    expect(dispatched[2]).toMatchObject({
      type: "providers_wizard_opened",
      wizard: {
        mode: "add",
        kind: "openai-compatible",
        presetId: "ollama",
        baseUrlLine: "http://127.0.0.1:11434",
        phase: "chat_model_line",
      },
    });
  });

  it("prefills the manual compat route for a non-Ollama server", () => {
    const dispatched = press(
      "",
      emptyKey({ return: true }),
      steerState("http://127.0.0.1:5001"),
    );
    expect(dispatched[2]).toMatchObject({
      type: "providers_wizard_opened",
      wizard: {
        kind: "openai-compatible",
        presetId: null,
        baseUrlLine: "http://127.0.0.1:5001",
        phase: "base_url",
      },
    });
  });

  it("n and Esc dismiss without opening the wizard", () => {
    for (const [input, key] of [
      ["n", emptyKey()],
      ["", emptyKey({ escape: true })],
    ] as const) {
      const dispatched = press(input, key, steerState());
      expect(dispatched).toEqual([{ type: "llm_external_compat_steer_closed" }]);
    }
  });

  it("swallows panel hotkeys while the prompt is open", () => {
    // `s` is the daemon start/stop hotkey outside the modal.
    const onStop = vi.fn();
    const dispatched = press(
      "s",
      emptyKey(),
      steerState(),
      callbacks({ onLocalModelsDaemonStopRequested: onStop }),
    );
    expect(dispatched).toEqual([]);
    expect(onStop).not.toHaveBeenCalled();
  });
});
