import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { LocalModelsPanel } from "./local-models-panel.js";
import { LlmPanel } from "./llm-panel.js";
import { createInitialLocalModelsPanelState } from "../local-models/local-models-panel-state.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import {
  LOCAL_MODELS_CATALOG,
  EMBEDDING_MODELS_CATALOG,
} from "../../local-llm/models-catalog.js";

/**
 * Regression guard for the "small window garbles the panel" bug. Ink 7
 * does NOT clip a frame taller than the terminal — it overlaps earlier
 * lines (the section headers get overwritten by list rows). The Manage
 * panels therefore split the per-tab budget between their fixed chrome
 * and a windowed list, collapsing verbose chrome when short, so the
 * rendered frame never exceeds the budget while always keeping a
 * section header visible.
 */

function modelsPanelWithCatalog() {
  const base = createInitialLocalModelsPanelState();
  return {
    ...base,
    cursor: 2,
    daemon: { ...base.daemon, running: true, healthy: true, pid: 123 },
    rows: LOCAL_MODELS_CATALOG.map((def) => ({
      id: def.id,
      def,
      downloaded: false,
      active: false,
      mmprojStatus: "n/a" as const,
    })),
    embeddingRows: EMBEDDING_MODELS_CATALOG.map((def) => ({
      id: def.id,
      def,
      downloaded: false,
      active: false,
    })),
  };
}

function llmStateWithCatalog(): TuiState {
  const base = createInitialTuiState(
    {
      sessionId: "abc12345",
      workingDir: "/tmp",
      llamaUrl: "http://127.0.0.1:19091",
      browserChannel: "chrome",
      browserHeadless: true,
      approvalLevel: 5,
      maxSteps: 20,
      skillCount: 0,
    },
    500,
    { uiMode: "debug", activeTab: "llm" },
  );
  return {
    ...base,
    localModelsPanel: {
      ...base.localModelsPanel,
      daemon: {
        ...base.localModelsPanel.daemon,
        running: true,
        healthy: true,
        pid: 1,
      },
      rows: LOCAL_MODELS_CATALOG.map((def) => ({
        id: def.id,
        def,
        downloaded: false,
        active: false,
        mmprojStatus: "n/a" as const,
      })),
      embeddingRows: EMBEDDING_MODELS_CATALOG.map((def) => ({
        id: def.id,
        def,
        downloaded: false,
        active: false,
      })),
    },
  };
}

describe("Manage panels never exceed their tab budget", () => {
  for (const budget of [8, 12, 16, 24]) {
    it(`Models panel fits budget ${budget} with a section header`, () => {
      const { lastFrame } = render(
        <LocalModelsPanel panel={modelsPanelWithCatalog()} maxRows={budget} />,
      );
      const frame = lastFrame() ?? "";
      expect(frame.split("\n").length).toBeLessThanOrEqual(budget);
      expect(frame).toMatch(/Chat models|Embedding models/);
    });
  }

  for (const budget of [8, 14, 22, 30]) {
    it(`LLM panel fits budget ${budget} with a section header`, () => {
      const { lastFrame } = render(
        <LlmPanel state={llmStateWithCatalog()} maxRows={budget} />,
      );
      const frame = lastFrame() ?? "";
      expect(frame.split("\n").length).toBeLessThanOrEqual(budget);
      expect(frame).toMatch(/Local text models|Local embeddings/);
    });
  }
});
