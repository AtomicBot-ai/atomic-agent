import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";
import type { LocalModelDef } from "../../local-llm/index.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import { handleLlmPanelKey } from "./llm-panel-key-bindings.js";

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

describe("handleLlmPanelKey", () => {
  it("moves the cursor inside the active mode", () => {
    const state = seededState();
    const dispatched: TuiAction[] = [];
    const handled = handleLlmPanelKey("j", emptyKey(), {
      state,
      dispatch: (action) => dispatched.push(action),
      callbacks: callbacks(),
    });
    expect(handled).toBe(true);
    expect(dispatched).toEqual([{ type: "llm_cursor_set", cursor: 0 }]);
  });

  it("switches panel modes without changing the active route", () => {
    const state = seededState();
    const dispatched: TuiAction[] = [];
    const onSetActiveText = vi.fn();
    const onStop = vi.fn();
    handleLlmPanelKey("]", emptyKey(), {
      state,
      dispatch: (action) => dispatched.push(action),
      callbacks: callbacks({
        onProvidersSetActiveText: onSetActiveText,
        onLocalModelsDaemonStopRequested: onStop,
      }),
    });
    expect(dispatched).toEqual([{ type: "llm_mode_set", mode: "cloud" }]);
    expect(onSetActiveText).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("selects an exact cloud text model", () => {
    const base = seededState();
    const state = {
      ...base,
      llmPanel: { ...base.llmPanel, mode: "cloud" as const, cloudCursor: 1 },
    };
    const dispatched: TuiAction[] = [];
    const onSelectChatModel = vi.fn();
    const onStop = vi.fn();
    handleLlmPanelKey("", emptyKey({ return: true }), {
      state,
      dispatch: (action) => dispatched.push(action),
      callbacks: callbacks({
        onProvidersSelectChatModel: onSelectChatModel,
        onLocalModelsDaemonStopRequested: onStop,
      }),
    });
    expect(dispatched).toEqual([]);
    expect(onSelectChatModel).toHaveBeenCalledWith(
      "openrouter",
      "openai/gpt-4o-mini",
    );
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("selects an exact cloud embedding model", () => {
    const base = seededState();
    const state = {
      ...base,
      providersPanel: {
        ...base.providersPanel,
        rows: base.providersPanel.rows.map((row) =>
          row.id === "openrouter" ? { ...row, kind: "openai-compatible" } : row,
        ),
      },
      llmPanel: { ...base.llmPanel, mode: "cloud" as const, cloudCursor: 2 },
    };
    const dispatched: TuiAction[] = [];
    const onSelectEmbeddingModel = vi.fn();
    handleLlmPanelKey("", emptyKey({ return: true }), {
      state,
      dispatch: (action) => dispatched.push(action),
      callbacks: callbacks({
        onProvidersSelectEmbeddingModel: onSelectEmbeddingModel,
      }),
    });
    expect(dispatched).toEqual([]);
    expect(onSelectEmbeddingModel).toHaveBeenCalledWith(
      "openrouter",
      "openai/text-embedding-3-small",
    );
  });


  it("answers the stop-daemon prompt by stopping local daemons", () => {
    const onStop = vi.fn();
    const base = seededState();
    const state = {
      ...base,
      llmPanel: {
        ...base.llmPanel,
        stopLocalDaemonsPrompt: { providerId: "openrouter" },
      },
    };
    const dispatched: TuiAction[] = [];
    handleLlmPanelKey("y", emptyKey(), {
      state,
      dispatch: (action) => dispatched.push(action),
      callbacks: callbacks({ onLocalModelsDaemonStopRequested: onStop }),
    });
    expect(dispatched).toEqual([{ type: "llm_stop_local_daemons_prompt_closed" }]);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("activates a downloaded local model and switches text route to local-llama", () => {
    const onSetActive = vi.fn();
    const onSetActiveText = vi.fn();
    const seeded = seededState();
    const base = {
      ...seeded,
      providersPanel: {
        ...seeded.providersPanel,
        rows: seeded.providersPanel.rows.map((row) => ({
          ...row,
          isActiveText: row.id === "openrouter",
        })),
      },
    };
    const state = {
      ...base,
      llmPanel: { ...base.llmPanel, mode: "local" as const, localCursor: 0 },
    };
    const dispatched: TuiAction[] = [];
    handleLlmPanelKey("", emptyKey({ return: true }), {
      state,
      dispatch: (action) => dispatched.push(action),
      callbacks: callbacks({
        onLocalModelsSetActiveRequested: onSetActive,
        onProvidersSetActiveText: onSetActiveText,
      }),
    });
    expect(onSetActive).toHaveBeenCalledWith("qwen-3.5-4b");
    expect(onSetActiveText).toHaveBeenCalledWith("local-llama");
    expect(dispatched).not.toContainEqual({ type: "llm_dashboard_opened" });
  });

  it("opens the slash-command palette when `/` is pressed", () => {
    const state = seededState();
    const dispatched: TuiAction[] = [];
    const handled = handleLlmPanelKey("/", emptyKey(), {
      state,
      dispatch: (action) => dispatched.push(action),
      callbacks: callbacks(),
    });
    expect(handled).toBe(true);
    expect(dispatched).toEqual([
      { type: "input_changed", value: "/" },
      { type: "slash_palette_opened", query: "" },
    ]);
  });

  it("captures provider wizard keys while the LLM tab is active", () => {
    const state = {
      ...seededState(),
      providersPanel: {
        ...seededState().providersPanel,
        wizard: {
          mode: "add" as const,
          providerId: null,
          kind: null,
          phase: "pick_kind" as const,
          cursor: 0,
          apiKeyBuffer: "",
          baseUrlLine: "",
          chatModelLine: "",
          embeddingModelLine: "",
          selectedChatModelId: null,
          selectedEmbeddingChoiceId: null,
          error: null,
          submitting: false,
        },
      },
    };
    const dispatched: TuiAction[] = [];
    handleLlmPanelKey("j", emptyKey(), {
      state,
      dispatch: (action) => dispatched.push(action),
      callbacks: callbacks(),
    });
    expect(dispatched[0]).toMatchObject({
      type: "providers_wizard_updated",
      wizard: { cursor: 1 },
    });
  });
});

function seededState() {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    uiMode: "debug" as const,
    activeTab: "llm" as const,
    providersPanel: {
      ...base.providersPanel,
      rows: [
        {
          id: "openrouter",
          kind: "openrouter",
          isActiveText: false,
          isActiveEmbedding: false,
          hasApiKey: true,
          chatModel: "openai/gpt-4o-mini",
          chatModelOptions: ["openai/gpt-4o-mini"],
          embeddingModel: "openai/text-embedding-3-small",
        },
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
    localModelsPanel: {
      ...base.localModelsPanel,
      daemon: {
        running: true,
        healthy: true,
        loading: false,
        pid: 42,
        port: 19091,
      },
      rows: [
        {
          id: "qwen-3.5-4b",
          def: localDef("qwen-3.5-4b"),
          downloaded: true,
          active: false,
          mmprojStatus: "n/a" as const,
        },
      ],
    },
  };
}

function localDef(id: LocalModelDef["id"]): LocalModelDef {
  return {
    id,
    name: id,
    filename: `${id}.gguf`,
    huggingFaceUrl: "u",
    fileSizeGb: 1,
    sizeLabel: "1 GB",
    description: "",
    maxContextLength: 4096,
    contextLabel: "4k",
    minRamGb: 1,
    recommendedRamGb: 2,
    family: "qwen",
    supportsVision: false,
  };
}
