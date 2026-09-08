import { describe, expect, it } from "vitest";

import {
  createIssueReportState,
  isIssueReportAction,
  reduceIssueReport,
  type IssueReportPreview,
} from "./issue-report-state.js";

const PREVIEW: IssueReportPreview = {
  level: "errors",
  zipPath: "/tmp/r.zip",
  zipBytes: 10,
  title: "t",
  bodyChars: 100,
  comments: 0,
  overflow: [],
};

describe("reduceIssueReport", () => {
  it("opens on pick, wraps the cursor, closes to null", () => {
    let s = reduceIssueReport(null, { type: "issue_report_opened" }, 3);
    expect(s).toEqual(createIssueReportState());
    s = reduceIssueReport(s, { type: "issue_report_cursor_moved", delta: -1 }, 3);
    expect(s?.cursor).toBe(2);
    s = reduceIssueReport(s, { type: "issue_report_cursor_moved", delta: 1 }, 3);
    expect(s?.cursor).toBe(0);
    expect(reduceIssueReport(s, { type: "issue_report_closed" }, 3)).toBeNull();
  });

  it("walks building → confirm → sending → sent", () => {
    let s = reduceIssueReport(null, { type: "issue_report_opened" }, 3);
    s = reduceIssueReport(s, { type: "issue_report_building" }, 3);
    expect(s?.step).toBe("building");
    // The cursor is frozen once a level is chosen.
    expect(reduceIssueReport(s, { type: "issue_report_cursor_moved", delta: 1 }, 3)).toBe(s);
    s = reduceIssueReport(s, { type: "issue_report_previewed", preview: PREVIEW }, 3);
    expect(s?.step).toBe("confirm");
    expect(s?.preview).toEqual(PREVIEW);
    s = reduceIssueReport(s, { type: "issue_report_sending" }, 3);
    expect(s?.step).toBe("sending");
    s = reduceIssueReport(s, { type: "issue_report_sent", url: "https://x/1" }, 3);
    expect(s?.step).toBe("sent");
    expect(s?.url).toBe("https://x/1");
  });

  it("records a failure and keeps the preview so the zip path stays visible", () => {
    let s = reduceIssueReport(null, { type: "issue_report_opened" }, 3);
    s = reduceIssueReport(s, { type: "issue_report_previewed", preview: PREVIEW }, 3);
    s = reduceIssueReport(s, { type: "issue_report_failed", error: "401" }, 3);
    expect(s?.step).toBe("error");
    expect(s?.error).toBe("401");
    expect(s?.preview).toEqual(PREVIEW);
  });

  it("does not reopen over a send in flight", () => {
    let s = reduceIssueReport(null, { type: "issue_report_opened" }, 3);
    s = reduceIssueReport(s, { type: "issue_report_sending" }, 3);
    expect(reduceIssueReport(s, { type: "issue_report_opened" }, 3)).toBe(s);
  });

  it("ignores progress actions when closed", () => {
    expect(reduceIssueReport(null, { type: "issue_report_sending" }, 3)).toBeNull();
    expect(reduceIssueReport(null, { type: "issue_report_failed", error: "x" }, 3)).toBeNull();
  });

  it("narrows by prefix", () => {
    expect(isIssueReportAction({ type: "issue_report_opened" })).toBe(true);
    expect(isIssueReportAction({ type: "integrations_opened" })).toBe(false);
  });
});
