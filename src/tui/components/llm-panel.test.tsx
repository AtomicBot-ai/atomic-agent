import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { createInitialTuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import { LlmPanel } from "./llm-panel.js";

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
