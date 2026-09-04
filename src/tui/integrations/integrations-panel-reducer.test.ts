import { describe, expect, it } from "vitest";

import { reduceIntegrationsAction } from "./integrations-panel-reducer.js";
import {
  createInitialIntegrationsPanelState,
  type IntegrationRow,
  type IntegrationsPanelState,
} from "./integrations-panel-state.js";
import type { TuiState } from "../tui-state.js";

function rowOf(id: string, fields = 1): IntegrationRow {
  return {
    id,
    label: id,
    summary: "",
    level: "not_configured",
    appliesLive: true,
    fields: Array.from({ length: fields }, (_, i) => ({
      key: `f${i}`,
      label: `Field ${i}`,
      display: "—",
      present: false,
    })),
  };
}

function stateWith(
  panel: Partial<IntegrationsPanelState> = {},
): TuiState {
  return {
    integrationsPanel: { ...createInitialIntegrationsPanelState(), ...panel },
  } as unknown as TuiState;
}

function panelAfter(
  panel: Partial<IntegrationsPanelState>,
  action: { type: string } & Record<string, unknown>,
): IntegrationsPanelState {
  const next = reduceIntegrationsAction(stateWith(panel), action);
  return (next as TuiState).integrationsPanel;
}

describe("reduceIntegrationsAction", () => {
  it("declines actions from other slices", () => {
    expect(reduceIntegrationsAction(stateWith(), { type: "privacy_synced" })).toBeNull();
  });

  it("clamps the cursor when a sync shrinks the list", () => {
    // Rows can shrink under the operator; jumping the selection out of
    // range would crash the detail view.
    const panel = panelAfter(
      { selected: 5, rows: [rowOf("a"), rowOf("b"), rowOf("c")] },
      { type: "integrations_synced", rows: [rowOf("a")] },
    );
    expect(panel.selected).toBe(0);
  });

  it("keeps the cursor where it was across a re-sync", () => {
    const rows = [rowOf("a"), rowOf("b"), rowOf("c")];
    const panel = panelAfter(
      { selected: 2, rows },
      { type: "integrations_synced", rows },
    );
    expect(panel.selected).toBe(2);
  });

  it("moves the list cursor and clamps at both ends", () => {
    const rows = [rowOf("a"), rowOf("b")];
    expect(panelAfter({ rows, selected: 0 }, { type: "integrations_moved", delta: -1 }).selected).toBe(0);
    expect(panelAfter({ rows, selected: 0 }, { type: "integrations_moved", delta: 1 }).selected).toBe(1);
    expect(panelAfter({ rows, selected: 1 }, { type: "integrations_moved", delta: 1 }).selected).toBe(1);
  });

  it("does not move the list cursor while in detail mode", () => {
    const rows = [rowOf("a"), rowOf("b")];
    const panel = panelAfter(
      { rows, selected: 0, mode: "detail" },
      { type: "integrations_moved", delta: 1 },
    );
    expect(panel.selected).toBe(0);
  });

  it("opens into detail and resets the field cursor", () => {
    const panel = panelAfter(
      { rows: [rowOf("a", 3)], selectedField: 2 },
      { type: "integrations_opened" },
    );
    expect(panel.mode).toBe("detail");
    expect(panel.selectedField).toBe(0);
  });

  it("refuses to open an empty list", () => {
    expect(panelAfter({ rows: [] }, { type: "integrations_opened" }).mode).toBe(
      "list",
    );
  });

  it("starts an edit with an empty buffer, never the current secret", () => {
    // Seeding the buffer with the stored value would put the key back on
    // screen in plain text, defeating the masking everywhere else.
    const panel = panelAfter(
      { rows: [rowOf("a")], mode: "detail" },
      { type: "integrations_edit_started" },
    );
    expect(panel.mode).toBe("edit");
    expect(panel.editBuffer).toBe("");
  });

  it("appends to and cancels the edit buffer", () => {
    const base = { rows: [rowOf("a")], mode: "edit" as const };
    expect(
      panelAfter(base, { type: "integrations_edit_changed", value: "ak_1" })
        .editBuffer,
    ).toBe("ak_1");
    const cancelled = panelAfter(
      { ...base, editBuffer: "ak_1" },
      { type: "integrations_edit_cancelled" },
    );
    expect(cancelled.mode).toBe("detail");
    expect(cancelled.editBuffer).toBe("");
  });

  it("clears the buffer when an action settles, so a key never lingers", () => {
    const panel = panelAfter(
      { rows: [rowOf("a")], mode: "edit", editBuffer: "ak_secret", busy: true },
      { type: "integrations_action_settled", message: "saved" },
    );
    expect(panel.busy).toBe(false);
    expect(panel.mode).toBe("detail");
    expect(panel.editBuffer).toBe("");
    expect(panel.message).toBe("saved");
  });

  it("replaces a stale error rather than stacking messages", () => {
    const panel = panelAfter(
      { lastError: "old", message: "old" },
      { type: "integrations_action_settled", message: "new" },
    );
    expect(panel.lastError).toBeNull();
    expect(panel.message).toBe("new");
  });
});
