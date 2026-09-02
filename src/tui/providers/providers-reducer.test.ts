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

describe("a refresh that switches the active text route", () => {
  const row = (overrides: Record<string, unknown>) => ({
    id: "a",
    kind: "openrouter",
    isActiveText: true,
    isActiveEmbedding: false,
    hasApiKey: true,
    chatModel: "openai/gpt-4o-mini",
    embeddingModel: null,
    ...overrides,
  });

  /** A state that has measured a prompt against a 32k window. */
  function measuredState() {
    const base = createInitialTuiState({
      session: { id: "s1", workingDir: "/tmp" },
    });
    const withRows = reduceProvidersPanel(base, {
      type: "providers_refresh",
      rows: [row({})],
    })!;
    return {
      ...withRows,
      contextUsage: {
        ...withRows.contextUsage,
        tokens: 14_000,
        contextWindow: 32_768,
      },
    };
  }

  /**
   * The window the last prompt was built against belongs to the model
   * that built it. `resolveWindow` prefers it over every live source, so
   * left standing it has the composer chip gauging the freshly chosen
   * model against the old model's window until the next prompt build.
   */
  it("drops the prompt-derived window when the chat model changes", () => {
    const next = reduceProvidersPanel(measuredState(), {
      type: "providers_refresh",
      rows: [row({ chatModel: "anthropic/claude-sonnet-5" })],
    })!;
    expect(next.contextUsage.contextWindow).toBeNull();
    // Only the window is stale — the measured prompt size still stands.
    expect(next.contextUsage.tokens).toBe(14_000);
  });

  it("drops it when a different provider takes over chat", () => {
    const next = reduceProvidersPanel(measuredState(), {
      type: "providers_refresh",
      rows: [
        row({ isActiveText: false }),
        row({ id: "b", chatModel: "openai/gpt-4o-mini" }),
      ],
    })!;
    expect(next.contextUsage.contextWindow).toBeNull();
  });

  it("keeps it across an ordinary refresh of the same route", () => {
    const next = reduceProvidersPanel(measuredState(), {
      type: "providers_refresh",
      rows: [row({ hasApiKey: false })],
    })!;
    expect(next.contextUsage.contextWindow).toBe(32_768);
  });

  it("does not treat the first population of the rows as a switch", () => {
    const base = {
      ...createInitialTuiState({ session: { id: "s1", workingDir: "/tmp" } }),
    };
    const seeded = {
      ...base,
      contextUsage: {
        ...base.contextUsage,
        tokens: 14_000,
        contextWindow: 32_768,
      },
    };
    const next = reduceProvidersPanel(seeded, {
      type: "providers_refresh",
      rows: [row({})],
    })!;
    expect(next.contextUsage.contextWindow).toBe(32_768);
  });
});
