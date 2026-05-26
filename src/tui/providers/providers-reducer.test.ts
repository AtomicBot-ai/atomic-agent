import { describe, it, expect } from "vitest";
import { createInitialTuiState } from "../tui-state.js";
import { reduceProvidersPanel } from "./providers-reducer.js";

describe("reduceProvidersPanel", () => {
  it("moves cursor on j/k", () => {
    const state = createInitialTuiState({
      session: { id: "s1", workingDir: "/tmp" },
    });
    const withRows = reduceProvidersPanel(state, {
      type: "providers_refresh",
      rows: [
        {
          id: "a",
          kind: "llama-server",
          isActiveText: true,
          isActiveEmbedding: false,
          hasApiKey: false,
          chatModel: null,
          embeddingModel: null,
        },
        {
          id: "b",
          kind: "openrouter",
          isActiveText: false,
          isActiveEmbedding: false,
          hasApiKey: true,
          chatModel: "openai/gpt-4o-mini",
          embeddingModel: null,
        },
      ],
    })!;
    expect(withRows.providersPanel.cursor).toBe(0);
    const down = reduceProvidersPanel(withRows, { type: "providers_cursor_down" })!;
    expect(down.providersPanel.cursor).toBe(1);
  });
});
