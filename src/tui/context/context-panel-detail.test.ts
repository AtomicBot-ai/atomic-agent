import { describe, expect, it } from "vitest";
import type { Key } from "ink";
import { dispatchSlashCommand } from "../commands/slash-command-handler.js";
import { reduceTuiState } from "../agent-event-reducer.js";
import type { TuiAction } from "../tui-action.js";
import { createInitialTuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import { fitBody, hasToolRows, type PanelRow } from "./context-panel-body.js";
import { handleContextPanelKey } from "./context-panel-keys.js";
import type { ContextUsageView } from "./select-context-usage.js";

/** ATO-2453: per-tool rows behind `/context detail` and `d`. */

const TOOLS = Array.from({ length: 9 }, (_, i) => ({ label: `tool${i}`, tokens: 900 - i * 100 }));

function usage(): ContextUsageView {
  return {
    tokens: 12_000, contextWindow: 32_768, percent: 37,
    conversationTokens: 2000, conversationCap: 8000, conversationPercent: 25, capSource: null,
    droppedTurns: 0, pairs: 1, pairsCap: 20, droppedPairs: 0, pairCosts: [2000],
    sections: [{ label: "prompt scaffold", tokens: 10_000 }, { label: "conversation", tokens: 2000 }],
    parts: [
      { label: "built-in tools", tokens: 5500, parent: "prompt scaffold" },
      { label: "mcp github", tokens: 4500, parent: "prompt scaffold", mcpServer: "github", tools: TOOLS },
    ],
    toolSearchActive: true,
  };
}

const ROWS: PanelRow[] = [
  { label: "prompt scaffold", tokens: 10_000 },
  { label: "conversation", tokens: 2000 },
];

const toolLabels = (rows: readonly PanelRow[]) => rows.filter((r) => r.tool).map((r) => r.label);

describe("fitBody detail", () => {
  it("lists no tools unless asked", () => {
    expect(toolLabels(fitBody(ROWS, usage(), 40).visible)).toEqual([]);
  });

  it("lists every tool of the server when they fit", () => {
    const { visible } = fitBody(ROWS, usage(), 40, true);
    expect(toolLabels(visible)).toEqual(TOOLS.map((t) => t.label));
    const at = visible.findIndex((r) => r.label === "mcp github");
    expect(visible[at + 1]?.label).toBe("tool0");
  });

  it("folds the rest into one row that keeps the sum on a short pane", () => {
    // The tip takes 2 lines (github is over 10% of 32k). Rows 2 + parts 2
    // + 5 tools + 1 fold + tip 2 = 12; all nine tools would need 15.
    const { visible, hint } = fitBody(ROWS, usage(), 12, true);
    expect(hint).toHaveLength(2);
    expect(toolLabels(visible)).toEqual(["tool0", "tool1", "tool2", "tool3", "tool4", "+4 more"]);
    const sum = visible.filter((r) => r.tool).reduce((a, r) => a + r.tokens, 0);
    expect(sum).toBe(4500);
  });

  it("drops the tools before the parts when even that does not fit", () => {
    // Rows 2 + parts 2 + tip 2.
    const { visible } = fitBody(ROWS, usage(), 6, true);
    expect(toolLabels(visible)).toEqual([]);
    expect(visible.map((r) => r.label)).toContain("mcp github");
  });

  it("knows when there is anything to expand", () => {
    expect(hasToolRows(usage())).toBe(true);
    expect(hasToolRows({ ...usage(), parts: [] })).toBe(false);
  });
});

describe("opening and toggling detail", () => {
  const base = () => createInitialTuiState(fakeSession());

  it("/context detail opens the panel with tools listed; /context opens it folded", () => {
    expect(dispatchSlashCommand("/context detail").actions).toEqual([{ type: "context_panel_detail_shown" }]);
    expect(dispatchSlashCommand("/context").actions).toEqual([{ type: "context_panel_toggled" }]);
    const shown = reduceTuiState(base(), { type: "context_panel_detail_shown" });
    expect(shown.contextPanelOpen).toBe(true);
    expect(shown.contextPanelDetail).toBe(true);
  });

  it("d flips detail only while the panel is open, and closing folds it", () => {
    const actions: TuiAction[] = [];
    const open = reduceTuiState(base(), { type: "context_panel_toggled" });
    expect(open.contextPanelDetail).toBe(false);
    const handled = handleContextPanelKey("d", {} as Key, { state: open, dispatch: (a) => actions.push(a) });
    expect(handled).toBe(true);
    expect(actions).toEqual([{ type: "context_panel_detail_toggled" }]);
    const detailed = reduceTuiState(open, { type: "context_panel_detail_toggled" });
    expect(detailed.contextPanelDetail).toBe(true);
    expect(reduceTuiState(detailed, { type: "context_panel_closed" }).contextPanelDetail).toBe(false);
    expect(reduceTuiState(base(), { type: "context_panel_detail_toggled" }).contextPanelDetail).toBe(false);
    // Reopening with the chip or `/context` starts folded again.
    const reopened = reduceTuiState(
      reduceTuiState(detailed, { type: "context_panel_toggled" }),
      { type: "context_panel_toggled" },
    );
    expect(reopened.contextPanelDetail).toBe(false);
  });
});
