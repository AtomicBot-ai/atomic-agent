import { describe, expect, it, vi } from "vitest";
import type { Key } from "ink";

import { handleAppKey, type AppKeyContext } from "../app-key-bindings.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import type { IssueReportState } from "./issue-report-state.js";

const KEY: Key = {
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
} as Key;

function report(step: IssueReportState["step"], cursor = 0): IssueReportState {
  return { step, cursor, preview: null, url: null, error: null };
}

function ctx(state: TuiState) {
  const dispatch = vi.fn();
  const callbacks = {
    onApprovalDecision: vi.fn(),
    onAbort: vi.fn(),
    onQuit: vi.fn(),
    onIssueReportPickRequested: vi.fn(),
    onIssueReportSendRequested: vi.fn(),
    onIssueReportCloseRequested: vi.fn(),
  };
  const c = {
    state,
    dispatch,
    callbacks,
    ctrlCArmed: false,
    setCtrlCArmed: vi.fn(),
    sidebarVisible: true,
    menuLeaderArmed: false,
    setMenuLeaderArmed: vi.fn(),
    activateMenuNode: vi.fn(),
  } as unknown as AppKeyContext;
  return { c, dispatch, callbacks };
}

function withReport(r: IssueReportState): TuiState {
  return { ...createInitialTuiState(fakeSession()), issueReport: r };
}

describe("issue-report popup keys", () => {
  it("owns every key while open", () => {
    const { c, dispatch } = ctx(withReport(report("pick")));
    expect(handleAppKey("x", KEY, c)).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("moves the cursor with arrows and j/k while picking", () => {
    const { c, dispatch } = ctx(withReport(report("pick")));
    handleAppKey("", { ...KEY, downArrow: true }, c);
    handleAppKey("k", KEY, c);
    expect(dispatch.mock.calls.map((call) => call[0])).toEqual([
      { type: "issue_report_cursor_moved", delta: 1 },
      { type: "issue_report_cursor_moved", delta: -1 },
    ]);
  });

  it("enter picks the level under the cursor; a digit picks directly", () => {
    const state = withReport(report("pick", 1));
    const { c, callbacks } = ctx(state);
    handleAppKey("", { ...KEY, return: true }, c);
    expect(callbacks.onIssueReportPickRequested).toHaveBeenLastCalledWith("scrubbed", state);
    handleAppKey("3", KEY, c);
    expect(callbacks.onIssueReportPickRequested).toHaveBeenLastCalledWith("full", state);
    handleAppKey("9", KEY, c);
    expect(callbacks.onIssueReportPickRequested).toHaveBeenCalledTimes(2);
  });

  it("esc closes from pick and confirm, telling the orchestrator", () => {
    for (const step of ["pick", "confirm"] as const) {
      const { c, dispatch, callbacks } = ctx(withReport(report(step)));
      handleAppKey("", { ...KEY, escape: true }, c);
      expect(callbacks.onIssueReportCloseRequested).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith({ type: "issue_report_closed" });
    }
  });

  it("confirm: enter or y sends, n cancels, other keys do nothing", () => {
    const { c, dispatch, callbacks } = ctx(withReport(report("confirm")));
    handleAppKey("", { ...KEY, return: true }, c);
    handleAppKey("y", KEY, c);
    expect(callbacks.onIssueReportSendRequested).toHaveBeenCalledTimes(2);
    handleAppKey("q", KEY, c);
    expect(dispatch).not.toHaveBeenCalled();
    handleAppKey("n", KEY, c);
    expect(dispatch).toHaveBeenCalledWith({ type: "issue_report_closed" });
  });

  it("ignores keys while building or sending so a leg cannot be abandoned", () => {
    for (const step of ["building", "sending"] as const) {
      const { c, dispatch, callbacks } = ctx(withReport(report(step)));
      handleAppKey("", { ...KEY, escape: true }, c);
      handleAppKey("", { ...KEY, return: true }, c);
      expect(dispatch).not.toHaveBeenCalled();
      expect(callbacks.onIssueReportCloseRequested).not.toHaveBeenCalled();
      expect(callbacks.onIssueReportSendRequested).not.toHaveBeenCalled();
    }
  });

  it("any key closes the sent and error screens", () => {
    for (const step of ["sent", "error"] as const) {
      const { c, dispatch } = ctx(withReport(report(step)));
      handleAppKey("x", KEY, c);
      expect(dispatch).toHaveBeenCalledWith({ type: "issue_report_closed" });
    }
  });
});
