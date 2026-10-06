import { Box } from "ink";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import {
  EMBEDDING_MODELS_CATALOG,
  LOCAL_MODELS_CATALOG,
} from "../../local-llm/catalog/models-catalog.js";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";
import { fakeSession } from "../test-fixtures.js";
import {
  createInitialTuiState,
  type TuiState,
  type TuiTab,
} from "../tui-state.js";
import { LlmPanel } from "../llm-panel/llm-panel.js";
import { LocalModelsPanel } from "../local-models/local-models-panel.js";
import { pullBarOnScreen } from "./pull-bar-owner.js";
import { StatusBar } from "./status-bar.js";

/**
 * ATO-6: one model download was drawn as three progress bars on the
 * Models tab — the status-bar chip, the panel's banner, and a mini bar
 * on the row being pulled. These render the status bar together with
 * the pane under it, the way `TuiApp` stacks them, and count bars.
 */

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

/**
 * Every bar the app draws: the panels' `[====    ]` (any width from the
 * old 8-cell row mini up) and the chip's `██████░░░░`.
 */
function countBars(frame: string): number {
  return (strip(frame).match(/\[[= ]{8,}\]|[█░]{10}/g) ?? []).length;
}

const CHAT_DEF = LOCAL_MODELS_CATALOG[0]!;
const EMBEDDING_DEF = EMBEDDING_MODELS_CATALOG[0]!;

function chatPull(): LocalModelsPullState {
  return {
    kind: "chat",
    modelId: CHAT_DEF.id,
    label: "chat model",
    percent: 50,
    transferredBytes: 50 * 1024 * 1024,
    totalBytes: 100 * 1024 * 1024,
    error: null,
  };
}

function embeddingPull(): LocalModelsPullState {
  return {
    kind: "embedding",
    modelId: EMBEDDING_DEF.id,
    label: "embedding model",
    percent: 50,
    transferredBytes: 50 * 1024 * 1024,
    totalBytes: 100 * 1024 * 1024,
    error: null,
  };
}

function stateOn(
  tab: TuiTab,
  over: {
    uiMode?: "chat" | "debug";
    pull?: LocalModelsPullState | null;
    embeddingPull?: LocalModelsPullState | null;
    panelMode?: TuiState["localModelsPanel"]["mode"];
  } = {},
): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    uiMode: over.uiMode ?? "debug",
    activeTab: tab,
    llmPanel: { ...base.llmPanel, mode: "local" },
    localModelsPanel: {
      ...base.localModelsPanel,
      mode: over.panelMode ?? base.localModelsPanel.mode,
      cursor: 0,
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
      pull: over.pull === undefined ? chatPull() : over.pull,
      embeddingPull: over.embeddingPull ?? null,
    },
  };
}

/** The status bar over the active pane, as `TuiApp` stacks them. */
function Screen({ state }: { state: TuiState }): ReactElement {
  return (
    <Box flexDirection="column">
      <StatusBar state={state} brand={false} />
      {state.uiMode === "debug" && state.activeTab === "models" ? (
        <LocalModelsPanel panel={state.localModelsPanel} maxRows={40} />
      ) : null}
      {state.uiMode === "debug" && state.activeTab === "llm" ? (
        <LlmPanel state={state} maxRows={40} />
      ) : null}
    </Box>
  );
}

function barsOn(state: TuiState): number {
  const { lastFrame, unmount } = render(<Screen state={state} />);
  const frame = lastFrame() ?? "";
  unmount();
  return countBars(frame);
}

describe("one download, one progress bar", () => {
  it("draws exactly one progress bar in the tree on the Models tab", () => {
    expect(barsOn(stateOn("models"))).toBe(1);
  });

  it("draws exactly one progress bar in the tree on the LLM tab's Local list", () => {
    expect(barsOn(stateOn("llm"))).toBe(1);
  });

  it("keeps the status-bar chip as the one bar off the download's panel", () => {
    expect(barsOn(stateOn("feed"))).toBe(1);
    expect(barsOn(stateOn("feed", { uiMode: "chat" }))).toBe(1);
  });

  it("keeps the chip when the Models pane is on a view without a banner", () => {
    expect(barsOn(stateOn("models", { panelMode: "detail" }))).toBe(1);
  });

  it("still names the downloading row and its progress, as text", () => {
    const { lastFrame, unmount } = render(
      <LocalModelsPanel
        panel={stateOn("models").localModelsPanel}
        maxRows={40}
      />,
    );
    const row = strip(lastFrame() ?? "")
      .split("\n")
      .find((line) => line.includes(CHAT_DEF.id) && line.includes("50%"));
    unmount();
    expect(row).toBeDefined();
    expect(row).toContain("⇣ 50%");
  });

  it("draws one bar per download when chat and embedding pulls run together", () => {
    const state = stateOn("models", { embeddingPull: embeddingPull() });
    expect(barsOn(state)).toBe(2);
  });

  it("draws nothing when there is nothing to download", () => {
    expect(barsOn(stateOn("models", { pull: null }))).toBe(0);
  });
});

describe("pullBarOnScreen", () => {
  it("is true only where a panel draws the pull's banner", () => {
    expect(pullBarOnScreen(stateOn("models"))).toBe(true);
    expect(pullBarOnScreen(stateOn("llm"))).toBe(true);
    expect(pullBarOnScreen(stateOn("feed"))).toBe(false);
    expect(pullBarOnScreen(stateOn("models", { uiMode: "chat" }))).toBe(false);
    expect(pullBarOnScreen(stateOn("models", { panelMode: "detail" }))).toBe(
      false,
    );
    expect(pullBarOnScreen(stateOn("models", { pull: null }))).toBe(false);
  });

  it("hands the bar back to the chip off the LLM tab's Local list", () => {
    const base = stateOn("llm");
    const state: TuiState = {
      ...base,
      llmPanel: { ...base.llmPanel, mode: "cloud" },
    };
    expect(pullBarOnScreen(state)).toBe(false);
  });
});
