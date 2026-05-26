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
});

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
