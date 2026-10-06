import type { Key } from "ink";
import type { AppKeyContext } from "../app-key-bindings.js";
import { ISSUE_REPORT_LEVELS } from "./report-levels.js";
import type { IssueReportState } from "./issue-report-state.js";

type IssueReportKeyContext = Pick<AppKeyContext, "state" | "dispatch" | "callbacks">;

export function handleIssueReportKey(
  input: string,
  key: Key,
  report: IssueReportState,
  ctx: IssueReportKeyContext,
): void {
  const { state, dispatch, callbacks } = ctx;
  const close = (): void => {
    // The orchestrator forgets its prepared report; the reducer closes
    // the popup. Both, so a stub without the callback still closes.
    callbacks.onIssueReportCloseRequested?.();
    dispatch({ type: "issue_report_closed" });
  };
  // A send in flight cannot be abandoned: the issue may already exist
  // and the link is the only thing left to show. A build can — the
  // orchestrator drops a result that arrives after the close.
  if (report.step === "sending") return;
  if (report.step === "building") {
    if (key.escape) close();
    return;
  }
  if (key.escape || report.step === "sent" || report.step === "error") {
    close();
    return;
  }
  if (report.step === "pick") {
    if (key.upArrow || key.downArrow || input === "j" || input === "k") {
      dispatch({
        type: "issue_report_cursor_moved",
        delta: key.downArrow || input === "j" ? 1 : -1,
      });
      return;
    }
    const digit = /^[1-9]$/.test(input) ? Number(input) - 1 : -1;
    const picked =
      digit >= 0
        ? ISSUE_REPORT_LEVELS[digit]
        : key.return
          ? ISSUE_REPORT_LEVELS[report.cursor]
          : undefined;
    if (picked) callbacks.onIssueReportPickRequested?.(picked.level, state);
    return;
  }
  if (report.step === "confirm") {
    if (input === "n") {
      close();
      return;
    }
    if (key.return || input === "y") callbacks.onIssueReportSendRequested?.();
  }
}
