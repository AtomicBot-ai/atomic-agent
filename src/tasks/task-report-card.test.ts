import { describe, expect, it } from "vitest";

import { buildTaskReportCard, stopCauseLine } from "./task-report-card.js";
import type { TaskRunSummary } from "./task-run-summary.js";

function summary(overrides: Partial<TaskRunSummary> = {}): TaskRunSummary {
  return {
    replyText: null,
    files: [],
    filesOmitted: 0,
    commands: [],
    commandsOmitted: 0,
    errors: [],
    errorsOmitted: 0,
    approvals: [],
    openItems: [],
    questions: [],
    creditExhausted: false,
    steps: 0,
    lastStep: null,
    ...overrides,
  };
}

describe("buildTaskReportCard", () => {
  it("sorts files and passing commands into Done, failing ones into Failed", () => {
    const card = buildTaskReportCard({
      status: "completed",
      summary: summary({
        files: [
          { path: "/w/a.ts", kind: "edited", added: 3, removed: 1, approximate: false, writes: 1 },
          { path: "/w/b.csv", kind: "rewritten", added: 3, removed: 2401, approximate: true, writes: 1 },
        ],
        commands: [
          { command: "npm test", exitCode: 0, timedOut: false, test: true, runs: 2 },
          { command: "npm run build", exitCode: 2, timedOut: false, test: false, runs: 1 },
          { command: "pytest", exitCode: null, timedOut: true, test: true, runs: 1 },
        ],
        errors: ["os.http.request: 500"],
      }),
    });
    expect(card.done).toEqual([
      "edited /w/a.ts +3 -1",
      "rewrote /w/b.csv +3 -2401 (approx.)",
      "$ npm test : tests passed (ran 2x, last shown)",
    ]);
    expect(card.failed).toEqual([
      "$ npm run build : exit 2",
      "$ pytest : tests failed, timed out",
      "os.http.request: 500",
    ]);
    expect(card.needsYou).toEqual([]);
  });

  it("puts approvals, blocked status, the stop cause, questions and open items under Needs you", () => {
    const card = buildTaskReportCard({
      status: "blocked",
      stopCause: "time_ceiling",
      summary: summary({
        approvals: [
          { tool: "os.fs.trash", byUser: true },
          { tool: "os.git.push", byUser: false },
        ],
        questions: ["Deploy now?"],
        openItems: ["update docs"],
      }),
    });
    expect(card.needsYou).toEqual([
      "You declined os.fs.trash.",
      "os.git.push needed an approval nobody gave.",
      "The task is blocked and will not retry on its own.",
      stopCauseLine("time_ceiling"),
      "Asked: Deploy now?",
      "Open: update docs",
    ]);
  });

  it("names the budget stop and falls back to credit exhaustion seen in events", () => {
    expect(
      buildTaskReportCard({ status: "completed", stopCause: "cost_ceiling", summary: null }).needsYou,
    ).toEqual(["Stopped at the budget limit. The work may not be finished."]);
    expect(
      buildTaskReportCard({ status: "failed", summary: summary({ creditExhausted: true }) }).needsYou,
    ).toEqual([stopCauseLine("credit_exhausted")]);
    expect(stopCauseLine("something_new")).toBe("Stopped early (something_new).");
  });

  it("says how many entries the collector did not keep", () => {
    const card = buildTaskReportCard({
      status: "completed",
      summary: summary({ filesOmitted: 4, commandsOmitted: 2, errorsOmitted: 1 }),
    });
    expect(card.done).toEqual([
      "… 4 more file changes not listed",
      "… 2 more commands not listed",
    ]);
    expect(card.failed).toEqual(["… 1 more errors not listed"]);
  });
});
