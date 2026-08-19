import { describe, expect, it } from "vitest";
import { reduceTuiState } from "../agent-event-reducer.js";
import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState } from "../tui-state.js";

describe("llm-panel reducer", () => {
  it("sets the visible mode from the active text provider", () => {
    const base = createInitialTuiState(fakeSession());
    const cloudActive = {
      ...base,
      llmPanel: { ...base.llmPanel, mode: "local" as const },
      providersPanel: {
        ...base.providersPanel,
        rows: [
          providerRow("local-llama", "llama-server", false),
          providerRow("openrouter", "openrouter", true),
        ],
      },
    };

    const cloud = reduceTuiState(cloudActive, {
      type: "llm_mode_set_to_active_route",
    });
    expect(cloud.llmPanel.mode).toBe("cloud");

    const local = reduceTuiState(
      {
        ...cloud,
        providersPanel: {
          ...cloud.providersPanel,
          rows: [
            providerRow("local-llama", "llama-server", true),
            providerRow("openrouter", "openrouter", false),
          ],
        },
      },
      { type: "llm_mode_set_to_active_route" },
    );
    expect(local.llmPanel.mode).toBe("local");
  });

  it("waits for provider rows before resolving the active route", () => {
    const base = createInitialTuiState(fakeSession());
    const pending = reduceTuiState(base, {
      type: "llm_mode_set_to_active_route",
    });

    expect(pending.llmPanel.mode).toBe("local");
    expect(pending.llmPanel.syncModeToActiveRoute).toBe(true);

    const refreshed = reduceTuiState(pending, {
      type: "providers_refresh",
      rows: [
        providerRow("local-llama", "llama-server", false),
        providerRow("openrouter", "openrouter", true),
      ],
    });

    expect(refreshed.llmPanel.mode).toBe("cloud");
    expect(refreshed.llmPanel.syncModeToActiveRoute).toBe(false);
  });

  it("applies the /model filter focus deferred by an unresolved route", () => {
    // The first /model of a session: provider rows have not landed yet,
    // so `llm_mode_set_to_active_route` cannot say which pane this is.
    const base = createInitialTuiState(fakeSession());
    const opened = MODEL_COMMAND_ACTIONS.reduce(reduceTuiState, base);

    expect(opened.llmPanel.syncModeToActiveRoute).toBe(true);
    expect(opened.llmPanel.cloudModelFilterFocused).toBe(false);

    const refreshed = reduceTuiState(opened, {
      type: "providers_refresh",
      rows: [
        providerRow("local-llama", "llama-server", false),
        providerRow("openrouter", "openrouter", true),
      ],
    });

    expect(refreshed.llmPanel.mode).toBe("cloud");
    expect(refreshed.llmPanel.cloudModelFilterFocused).toBe(true);
    // One cloud provider row precedes the model section (the llama-server
    // entry is not listed on this pane), and the cursor has to land
    // inside the section: parked at 0 it sits on that provider row, and
    // the first ↑/↓ is spent climbing in — which reads as a swallowed
    // keypress because the counter clamps to the first model either way.
    expect(refreshed.llmPanel.cloudCursor).toBe(1);
  });

  it("drops the deferred /model filter focus when the route is local", () => {
    const base = createInitialTuiState(fakeSession());
    const opened = MODEL_COMMAND_ACTIONS.reduce(reduceTuiState, base);

    const refreshed = reduceTuiState(opened, {
      type: "providers_refresh",
      rows: [
        providerRow("local-llama", "llama-server", true),
        providerRow("openrouter", "openrouter", false),
      ],
    });

    expect(refreshed.llmPanel.mode).toBe("local");
    expect(refreshed.llmPanel.cloudModelFilterFocused).toBe(false);
    expect(refreshed.llmPanel.pendingCloudFilterFocus).toBe(false);
  });
});

/**
 * What `/model` dispatches, in order (see `dispatchModelsSub`). The
 * `providers_inline_models_ensure_requested` action is intercepted by
 * `submit-handler` and never reaches the reducer, so it is not here.
 */
const MODEL_COMMAND_ACTIONS = [
  { type: "ui_mode_set", mode: "debug" },
  { type: "tab_changed", tab: "llm" },
  { type: "llm_mode_set_to_active_route" },
  { type: "llm_cloud_filter_focus_set", focused: true },
] as const;

function providerRow(id: string, kind: string, isActiveText: boolean) {
  return {
    id,
    kind,
    isActiveText,
    isActiveEmbedding: false,
    hasApiKey: kind !== "llama-server",
    chatModel: null,
    embeddingModel: null,
  };
}
