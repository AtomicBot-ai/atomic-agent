import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import type { ProvidersChatModelPickerState } from "../providers/providers-panel-state.js";
import { KIND_ROW_ORDER } from "../providers/providers-wizard-phases.js";
import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
import { LlmPanel } from "./llm-panel.js";

function stateWithPicker(
  overrides: Partial<ProvidersChatModelPickerState>,
): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    uiMode: "debug" as const,
    activeTab: "llm" as const,
    llmPanel: { ...base.llmPanel, mode: "cloud" as const },
    providersPanel: {
      ...base.providersPanel,
      chatModelPickerGeneration: 1,
      chatModelPicker: {
        providerId: "my-vllm",
        currentModelId: "qwen-32b",
        status: "ready",
        models: ["glm-9b", "qwen-32b", "yi-34b"],
        query: "",
        cursor: 0,
        error: null,
        generation: 1,
        ...overrides,
      },
    },
  };
}

function frameHeight(state: TuiState, maxRows: number): number {
  const { lastFrame } = render(<LlmPanel state={state} maxRows={maxRows} />);
  return (lastFrame() ?? "").split("\n").length;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("LlmPanel", () => {
  it("renders the local model download banner while a pull is active", () => {
    const base = createInitialTuiState(fakeSession());
    const state = {
      ...base,
      uiMode: "debug" as const,
      activeTab: "llm" as const,
      llmPanel: { ...base.llmPanel, mode: "local" as const },
      localModelsPanel: {
        ...base.localModelsPanel,
        pull: {
          kind: "chat" as const,
          modelId: "qwen-3.5-4b" as const,
          label: "Qwen 3.5 4B",
          percent: 42,
          transferredBytes: 42 * 1024 * 1024,
          totalBytes: 100 * 1024 * 1024,
          error: null,
        },
      },
    };

    const { lastFrame } = render(<LlmPanel state={state} />);
    const text = stripAnsi(lastFrame() ?? "");

    expect(text).toContain("downloading — Qwen 3.5 4B");
    expect(text).toContain("model: qwen-3.5-4b");
    expect(text).toContain("42%");
    expect(text).toContain("42.0 MB / 100.0 MB");
  });

  it("renders chat and embedding download banners at the same time", () => {
    const base = createInitialTuiState(fakeSession());
    const state = {
      ...base,
      uiMode: "debug" as const,
      activeTab: "llm" as const,
      llmPanel: { ...base.llmPanel, mode: "local" as const },
      localModelsPanel: {
        ...base.localModelsPanel,
        pull: {
          kind: "chat" as const,
          modelId: "qwen-3.5-4b" as const,
          label: "Qwen chat",
          percent: 25,
          transferredBytes: 25 * 1024 * 1024,
          totalBytes: 100 * 1024 * 1024,
          error: null,
        },
        embeddingPull: {
          kind: "embedding" as const,
          modelId: "nomic-embed-text-v1.5" as const,
          label: "Nomic embedding",
          percent: 60,
          transferredBytes: 60 * 1024 * 1024,
          totalBytes: 100 * 1024 * 1024,
          error: null,
        },
      },
    };

    const { lastFrame } = render(<LlmPanel state={state} />);
    const text = stripAnsi(lastFrame() ?? "");

    expect(text).toContain("downloading — Qwen chat");
    expect(text).toContain("model: qwen-3.5-4b");
    expect(text).toContain("25%");
    expect(text).toContain("downloading — Nomic embedding");
    expect(text).toContain("model: nomic-embed-text-v1.5");
    expect(text).toContain("60%");
  });
});

/**
 * Reported as "there is only aimlapi in the provider list" and "I don't
 * see OpenRouter on some screen sizes".
 *
 * Neither was a missing row: `KIND_ROW_ORDER` has always had all of
 * them. The wizard was drawn ON TOP of the whole LLM panel, so the frame
 * ran ~16 rows past the tab budget, and Ink 7 answers an over-tall frame
 * by painting later lines over earlier ones instead of clipping. Half
 * the provider rows arrived on screen wearing the tail of the row below
 * them. The budgets below are what `tabContentBudget` hands the tab at
 * 120x40, 100x30 and 80x24 — the three sizes the reports came from.
 */
describe("the add-provider wizard fits the terminal", () => {
  function stateWithWizard(): TuiState {
    const base = createInitialTuiState(fakeSession());
    return {
      ...base,
      uiMode: "debug" as const,
      activeTab: "llm" as const,
      llmPanel: { ...base.llmPanel, mode: "cloud" as const },
      providersPanel: {
        ...base.providersPanel,
        wizard: createProvidersWizardState("add"),
      },
    };
  }

  for (const budget of [27, 17, 11]) {
    it(`never exceeds a ${budget}-row budget`, () => {
      const { lastFrame } = render(
        <LlmPanel state={stateWithWizard()} maxRows={budget} />,
      );
      expect((lastFrame() ?? "").split("\n").length).toBeLessThanOrEqual(budget);
    });
  }

  it("still shows OpenRouter and the full-list counter on a short terminal", () => {
    const { lastFrame } = render(
      <LlmPanel state={stateWithWizard()} maxRows={11} />,
    );
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("OpenRouter");
    expect(text).toContain(`(1/${KIND_ROW_ORDER.length})`);
  });

  it("draws the modal alone, not stacked over the panel it covers", () => {
    // The panel is unreachable while the wizard owns the keyboard, and
    // drawing it was what spent the row budget twice.
    const { lastFrame } = render(
      <LlmPanel state={stateWithWizard()} maxRows={27} />,
    );
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).not.toContain("Active chat route");
    expect(text).not.toContain("n add provider");
  });
});

describe("model picker fixed height", () => {
  const MAX_ROWS = 20;

  it("loading, ready and error branches all render the same frame height", () => {
    const heights = [
      frameHeight(stateWithPicker({ status: "loading", models: [] }), MAX_ROWS),
      frameHeight(stateWithPicker({}), MAX_ROWS),
      frameHeight(
        stateWithPicker({ status: "error", error: "http 500" }),
        MAX_ROWS,
      ),
    ];
    expect(new Set(heights).size).toBe(1);
  });

  it("a narrowing filter keeps the frame height constant", () => {
    const full = frameHeight(stateWithPicker({ query: "" }), MAX_ROWS);
    const narrowed = frameHeight(stateWithPicker({ query: "qwen" }), MAX_ROWS);
    const empty = frameHeight(stateWithPicker({ query: "no-such" }), MAX_ROWS);
    expect(narrowed).toBe(full);
    expect(empty).toBe(full);
  });

  it("short terminals get a smaller window, still equal across branches", () => {
    const SHORT = 10;
    const heights = [
      frameHeight(stateWithPicker({ status: "loading", models: [] }), SHORT),
      frameHeight(stateWithPicker({}), SHORT),
      frameHeight(
        stateWithPicker({ status: "error", error: "http 500" }),
        SHORT,
      ),
    ];
    expect(new Set(heights).size).toBe(1);
    expect(heights[0]!).toBeLessThan(
      frameHeight(stateWithPicker({}), MAX_ROWS),
    );
  });
});
