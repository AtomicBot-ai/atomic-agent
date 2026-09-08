/**
 * UI state for the "Report an issue" popup, and the pure reducer over it.
 *
 * Five steps in a straight line — pick a level, wait for the zip,
 * confirm what is about to be sent, wait for GitHub, read the link —
 * and Esc leaves from any of them. The orchestrator drives the
 * transitions through actions; nothing here touches the disk or the
 * network.
 */

import type { IssueReportLevel } from "./report-levels.js";

export type IssueReportStep =
  | "pick"
  | "building"
  | "confirm"
  | "sending"
  | "sent"
  | "error";

export interface IssueReportPreview {
  level: IssueReportLevel;
  /** Absolute path of the zip already written. */
  zipPath: string;
  zipBytes: number;
  title: string;
  /** Characters in the issue body. */
  bodyChars: number;
  /** Follow-up comments the report needs beyond the body. */
  comments: number;
  /** Section titles that stay zip-only. */
  overflow: readonly string[];
}

export interface IssueReportState {
  step: IssueReportStep;
  /** Index into `ISSUE_REPORT_LEVELS` while picking. */
  cursor: number;
  preview: IssueReportPreview | null;
  url: string | null;
  error: string | null;
}

export type IssueReportAction =
  | { type: "issue_report_opened" }
  | { type: "issue_report_closed" }
  | { type: "issue_report_cursor_moved"; delta: number }
  | { type: "issue_report_building" }
  | { type: "issue_report_previewed"; preview: IssueReportPreview }
  | { type: "issue_report_sending" }
  | { type: "issue_report_sent"; url: string }
  | { type: "issue_report_failed"; error: string };

export function isIssueReportAction(action: {
  type: string;
}): action is IssueReportAction {
  return action.type.startsWith("issue_report_");
}

export function createIssueReportState(): IssueReportState {
  return { step: "pick", cursor: 0, preview: null, url: null, error: null };
}

export function reduceIssueReport(
  state: IssueReportState | null,
  action: IssueReportAction,
  levelCount: number,
): IssueReportState | null {
  switch (action.type) {
    case "issue_report_opened":
      // Re-opening while a leg is in flight would lose its outcome;
      // every other step starts over.
      if (state && (state.step === "sending" || state.step === "building")) return state;
      return createIssueReportState();
    case "issue_report_closed":
      return null;
    case "issue_report_cursor_moved": {
      if (!state || state.step !== "pick") return state;
      const next = (state.cursor + action.delta + levelCount) % levelCount;
      return { ...state, cursor: next };
    }
    case "issue_report_building":
      if (!state) return state;
      return { ...state, step: "building", error: null };
    case "issue_report_previewed":
      if (!state) return state;
      return { ...state, step: "confirm", preview: action.preview, error: null };
    case "issue_report_sending":
      if (!state) return state;
      return { ...state, step: "sending", error: null };
    case "issue_report_sent":
      if (!state) return state;
      return { ...state, step: "sent", url: action.url, error: null };
    case "issue_report_failed":
      if (!state) return state;
      return { ...state, step: "error", error: action.error };
    default:
      return state;
  }
}
