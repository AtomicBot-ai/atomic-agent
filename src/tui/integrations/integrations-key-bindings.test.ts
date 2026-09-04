import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";

import type { TuiAppCallbacks } from "../tui-app.js";
import {
  createInitialTuiState,
  type TuiSessionInfo,
  type TuiState,
} from "../tui-state.js";
import { handleIntegrationsTabKey } from "./integrations-key-bindings.js";
import type {
  IntegrationRow,
  IntegrationsPanelState,
} from "./integrations-panel-state.js";

const SESSION: TuiSessionInfo = {
  sessionId: null,
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: true,
  approvalLevel: 1,
  maxSteps: 10,
  skillCount: 0,
};

function emptyKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  };
}

const ROW: IntegrationRow = {
  id: "composio",
  label: "Composio",
  summary: "",
  level: "not_configured",
  appliesLive: true,
  fields: [
    { key: "apiKey", label: "API key", display: "—", present: false },
    { key: "other", label: "Other", display: "x", present: true },
  ],
};

function stateWith(panel: Partial<IntegrationsPanelState> = {}): TuiState {
  const state = createInitialTuiState(SESSION);
  return {
    ...state,
    uiMode: "debug",
    activeTab: "integrations",
    integrationsPanel: { ...state.integrationsPanel, rows: [ROW], ...panel },
  };
}

function ctx(state: TuiState, callbacks: Partial<TuiAppCallbacks> = {}) {
  const dispatch = vi.fn();
  return {
    ctx: { state, dispatch, callbacks: callbacks as TuiAppCallbacks },
    dispatch,
  };
}

describe("handleIntegrationsTabKey", () => {
  it("declines every key when another tab is active", () => {
    const state = { ...stateWith(), activeTab: "privacy" as const };
    const { ctx: c } = ctx(state);
    expect(handleIntegrationsTabKey("j", emptyKey(), c)).toBe(false);
  });

  it("swallows keys while an action is in flight", () => {
    // A second Enter during a save must not fire a duplicate write.
    const { ctx: c, dispatch } = ctx(stateWith({ busy: true }));
    expect(handleIntegrationsTabKey("e", emptyKey(), c)).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("moves and opens from the list", () => {
    const { ctx: c, dispatch } = ctx(stateWith());
    handleIntegrationsTabKey("j", emptyKey(), c);
    expect(dispatch).toHaveBeenCalledWith({
      type: "integrations_moved",
      delta: 1,
    });
    handleIntegrationsTabKey("", emptyKey({ return: true }), c);
    expect(dispatch).toHaveBeenCalledWith({ type: "integrations_opened" });
  });

  it("edits and clears from the detail view", () => {
    const onIntegrationFieldClearRequested = vi.fn();
    const { ctx: c, dispatch } = ctx(
      stateWith({ mode: "detail", selectedField: 1 }),
      { onIntegrationFieldClearRequested },
    );
    handleIntegrationsTabKey("e", emptyKey(), c);
    expect(dispatch).toHaveBeenCalledWith({ type: "integrations_edit_started" });
    handleIntegrationsTabKey("d", emptyKey(), c);
    expect(onIntegrationFieldClearRequested).toHaveBeenCalledWith(
      "composio",
      "other",
    );
  });

  it("does not try to clear a field that has no value", () => {
    const onIntegrationFieldClearRequested = vi.fn();
    const { ctx: c } = ctx(stateWith({ mode: "detail", selectedField: 0 }), {
      onIntegrationFieldClearRequested,
    });
    handleIntegrationsTabKey("d", emptyKey(), c);
    expect(onIntegrationFieldClearRequested).not.toHaveBeenCalled();
  });

  it("treats every printable key as key material while editing", () => {
    // `d`, `e` and `r` are bindings elsewhere on this tab; inside the
    // editor they are just characters, or pasting a key would trigger
    // "clear field" halfway through.
    const { ctx: c, dispatch } = ctx(
      stateWith({ mode: "edit", editBuffer: "ak_" }),
    );
    for (const ch of ["d", "e", "r"]) {
      handleIntegrationsTabKey(ch, emptyKey(), c);
      expect(dispatch).toHaveBeenCalledWith({
        type: "integrations_edit_changed",
        value: `ak_${ch}`,
      });
    }
  });

  it("consumes every key while editing so nothing leaks to the chat draft", () => {
    const { ctx: c } = ctx(stateWith({ mode: "edit" }));
    expect(handleIntegrationsTabKey("x", emptyKey(), c)).toBe(true);
    expect(handleIntegrationsTabKey("", emptyKey({ tab: true }), c)).toBe(true);
  });

  it("backspaces and saves from the editor", () => {
    const onIntegrationFieldSaveRequested = vi.fn();
    const { ctx: c, dispatch } = ctx(
      stateWith({ mode: "edit", editBuffer: "ak_12" }),
      { onIntegrationFieldSaveRequested },
    );
    handleIntegrationsTabKey("", emptyKey({ backspace: true }), c);
    expect(dispatch).toHaveBeenCalledWith({
      type: "integrations_edit_changed",
      value: "ak_1",
    });
    handleIntegrationsTabKey("", emptyKey({ return: true }), c);
    expect(onIntegrationFieldSaveRequested).toHaveBeenCalledWith(
      "composio",
      "apiKey",
      "ak_12",
    );
  });

  it("cancels the editor on escape and leaves detail on escape", () => {
    const { ctx: editing, dispatch: d1 } = ctx(stateWith({ mode: "edit" }));
    handleIntegrationsTabKey("", emptyKey({ escape: true }), editing);
    expect(d1).toHaveBeenCalledWith({ type: "integrations_edit_cancelled" });

    const { ctx: detail, dispatch: d2 } = ctx(stateWith({ mode: "detail" }));
    handleIntegrationsTabKey("", emptyKey({ escape: true }), detail);
    expect(d2).toHaveBeenCalledWith({ type: "integrations_closed" });
  });
});
