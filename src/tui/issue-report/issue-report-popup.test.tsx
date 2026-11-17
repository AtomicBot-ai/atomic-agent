import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { IssueReportPopup } from "./issue-report-popup.js";
import type { IssueReportState } from "./issue-report-state.js";

function popup(report: IssueReportState): string {
  // Absolutely positioned inside a relative pane, like in the app: with
  // no positioned ancestor the popup measures to nothing.
  const rows = 30;
  const columns = 100;
  const { lastFrame, unmount } = render(
    <Box
      flexDirection="column"
      position="relative"
      width={columns}
      height={rows}
    >
      {Array.from({ length: rows }, (_unused, row) => (
        <Text key={`bg-${row}`}>{"·".repeat(columns)}</Text>
      ))}
      <IssueReportPopup
        report={report}
        availableRows={rows}
        availableColumns={columns}
      />
    </Box>,
  );
  const frame = (lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
  unmount();
  return frame;
}

const BASE: IssueReportState = {
  step: "pick",
  cursor: 1,
  preview: null,
  url: null,
  error: null,
};

describe("IssueReportPopup", () => {
  it("lists the three levels with the cursor on the chosen one", () => {
    const frame = popup(BASE);
    expect(frame).toContain("REPORT AN ISSUE ON GITHUB");
    expect(frame).toContain("1. Errors only");
    expect(frame).toContain("❯ 2. Logs, scrubbed");
    expect(frame).toContain("3. Everything");
    expect(frame).toContain("warn/error log lines");
    expect(frame).toContain("↑↓ move · enter choose · esc cancel");
  });

  it("names the zip, the level and the destination before sending", () => {
    const frame = popup({
      ...BASE,
      step: "confirm",
      preview: {
        level: "scrubbed",
        zipPath: "/tmp/r.zip",
        zipBytes: 2048,
        title: "Turn failed [tool]: x",
        bodyChars: 1234,
        comments: 2,
        overflow: ["Trace abc"],
      },
    });
    expect(frame).toContain("SEND THIS REPORT?");
    expect(frame).toContain("Turn failed [tool]: x");
    expect(frame).toContain("Logs, scrubbed");
    expect(frame).toContain("AtomicBot-ai/atomic-agent");
    expect(frame).toContain("issue body + 2 comments");
    expect(frame).toContain("/tmp/r.zip (2.0 KB)");
    expect(frame).toContain("Not inline (too large): Trace abc");
    expect(frame).toContain("enter/y send");
  });

  it("shows the support id and log tail checkboxes (ATO-1466)", () => {
    const preview = {
      level: "errors" as const,
      zipPath: "/tmp/r.zip",
      zipBytes: 10,
      title: "t",
      bodyChars: 1,
      comments: 0,
      overflow: [],
    };
    const on = popup({
      ...BASE,
      step: "confirm",
      preview: {
        ...preview,
        supportId: "11111111-2222-4333-8444-555555555555",
        includeSupportId: true,
        includeLogs: true,
      },
    });
    expect(on).toContain(
      "[x] i  Include support ID (11111111-2222-4333-8444-555555555555)",
    );
    expect(on).toContain("[x] l  Include log tail");
    expect(on).toContain("i/l toggle");
    const off = popup({
      ...BASE,
      step: "confirm",
      preview: {
        ...preview,
        supportId: null,
        includeSupportId: false,
        includeLogs: false,
      },
    });
    expect(off).toContain("[ ] i  Include support ID (none on this machine)");
    expect(off).toContain("[ ] l  Include log tail");
  });

  it("shows the two waiting screens", () => {
    expect(popup({ ...BASE, step: "building" })).toContain(
      "Collecting logs and traces",
    );
    expect(popup({ ...BASE, step: "sending" })).toContain("Filing the issue");
  });

  it("shows the link once filed and the error when refused", () => {
    expect(
      popup({ ...BASE, step: "sent", url: "https://github.com/x/y/issues/1" }),
    ).toContain("https://github.com/x/y/issues/1");
    const err = popup({
      ...BASE,
      step: "error",
      error: "GitHub is not connected.",
    });
    expect(err).toContain("COULD NOT FILE THE ISSUE");
    expect(err).toContain("GitHub is not connected.");
  });
});
