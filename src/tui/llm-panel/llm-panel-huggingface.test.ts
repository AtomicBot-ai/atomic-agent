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

function baseState(): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    uiMode: "debug" as const,
    activeTab: "llm" as const,
    llmPanel: { ...base.llmPanel, mode: "local" as const },
  };
}

/** Drive a key through the panel and return the resulting state. */
function press(state: TuiState, input: string, key: Key = emptyKey()) {
  const dispatched: TuiAction[] = [];
  const sent: string[] = [];
  const handled = handleLlmPanelKey(input, key, {
    state,
    dispatch: (action) => dispatched.push(action),
    callbacks: callbacks({
      onLlmHuggingFaceSubmitted: (text) => {
        sent.push(text);
      },
    }),
  });
  let next = state;
  for (const action of dispatched) next = reduceLlmPanelAction(next, action) ?? next;
  return { handled, dispatched, next, sent };
}

describe("Hugging Face add row", () => {
  it("is pinned as the last local text row, under the models", () => {
    const rows = selectLlmPanelRows(baseState(), "local");
    const kinds = rows.map((row) => row.kind);
    const addIndex = kinds.indexOf("localAddHuggingFace");
    expect(addIndex).toBeGreaterThanOrEqual(0);
    // Every text model precedes it; every embedding row follows it.
    expect(kinds.slice(0, addIndex).every((k) => k === "localTextModel")).toBe(true);
    expect(kinds.slice(addIndex + 1).every((k) => k === "localEmbeddingModel")).toBe(
      true,
    );
  });

  it("opens the prompt when Enter lands on the row", () => {
    const rows = selectLlmPanelRows(baseState(), "local");
    const cursor = rows.findIndex((row) => row.kind === "localAddHuggingFace");
    const state = {
      ...baseState(),
      llmPanel: { ...baseState().llmPanel, localCursor: cursor },
    };
    const { next } = press(state, "", emptyKey({ return: true }));
    expect(next.llmPanel.huggingFacePrompt).toEqual({
      buffer: "",
      busy: false,
      error: null,
      results: [],
    });
  });
});

describe("Hugging Face prompt keys", () => {
  function opened(overrides = {}): TuiState {
    const base = baseState();
    return {
      ...base,
      llmPanel: {
        ...base.llmPanel,
        huggingFacePrompt: {
          buffer: "",
          busy: false,
          error: null,
          results: [],
          ...overrides,
        },
      },
    };
  }

  it("captures printable characters, including digits and slashes", () => {
    let state = opened();
    for (const ch of "unsloth/Qwen3-8B-GGUF") state = press(state, ch).next;
    expect(state.llmPanel.huggingFacePrompt?.buffer).toBe("unsloth/Qwen3-8B-GGUF");
  });

  it("does not let panel hotkeys steal characters from the buffer", () => {
    // `s`, `n`, `c`, `r`, `e` are all panel hotkeys outside the modal.
    let state = opened();
    for (const ch of "scner") state = press(state, ch).next;
    expect(state.llmPanel.huggingFacePrompt?.buffer).toBe("scner");
  });

  it("backspaces and submits the trimmed buffer", () => {
    let state = opened({ buffer: "org/repoX" });
    state = press(state, "", emptyKey({ backspace: true })).next;
    expect(state.llmPanel.huggingFacePrompt?.buffer).toBe("org/repo");
    const { sent } = press(state, "", emptyKey({ return: true }));
    expect(sent).toEqual(["org/repo"]);
  });

  it("ignores Enter on an empty buffer", () => {
    const { sent } = press(opened(), "", emptyKey({ return: true }));
    expect(sent).toEqual([]);
  });

  it("treats digits as a pick only when results are showing", () => {
    const withResults = opened({
      buffer: "qwen",
      results: [
        { repoId: "unsloth/Qwen3-8B-GGUF", downloads: 10 },
        { repoId: "Qwen/Qwen3-4B-GGUF", downloads: 5 },
      ],
    });
    expect(press(withResults, "2").sent).toEqual(["Qwen/Qwen3-4B-GGUF"]);
    // Out of range falls through to being typed.
    expect(press(withResults, "7").next.llmPanel.huggingFacePrompt?.buffer).toBe(
      "qwen7",
    );
    // No results: a digit is just a character (repo names contain them).
    expect(press(opened({ buffer: "Qwen" }), "3").next.llmPanel.huggingFacePrompt
      ?.buffer).toBe("Qwen3");
  });

  it("swallows keys while busy but still allows Esc", () => {
    const busy = opened({ buffer: "org/repo", busy: true });
    expect(press(busy, "x").next.llmPanel.huggingFacePrompt?.buffer).toBe("org/repo");
    expect(press(busy, "", emptyKey({ return: true })).sent).toEqual([]);
    expect(
      press(busy, "", emptyKey({ escape: true })).next.llmPanel.huggingFacePrompt,
    ).toBeNull();
  });

  it("closes on Esc", () => {
    const { next } = press(opened({ buffer: "abc" }), "", emptyKey({ escape: true }));
    expect(next.llmPanel.huggingFacePrompt).toBeNull();
  });
});
