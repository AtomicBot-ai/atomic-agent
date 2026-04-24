import { describe, expect, it } from "vitest";
import type { TaskRecord } from "../../tasks/task-types.js";
import {
  formatIntervalMs,
  formatRelativeMs,
  formatScheduleLabel,
  formatUnixMs,
  toTaskSummaryRow,
} from "./tasks-summary.js";

const BASE: TaskRecord = {
  id: "t-1",
  sessionId: "s-1",
  userMessage: "hello",
  maxSteps: null,
  status: "pending",
  origin: "tui",
  attempts: 0,
  maxAttempts: 3,
  lastError: null,
  lastErrorCategory: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  startedAt: null,
  completedAt: null,
  schedule: null,
  scheduledFor: null,
  recurring: false,
  lastScheduledAt: null,
  triggerSource: null,
};

describe("formatScheduleLabel", () => {
  it("renders `-` for null schedule", () => {
    expect(formatScheduleLabel(null)).toBe("-");
  });

  it("renders cron with optional tz suffix", () => {
    expect(formatScheduleLabel({ kind: "cron", expression: "0 * * * *" })).toBe(
      "cron: 0 * * * *",
    );
    expect(
      formatScheduleLabel({ kind: "cron", expression: "0 * * * *", tz: "UTC" }),
    ).toBe("cron: 0 * * * * (UTC)");
  });

  it("renders interval with a compact duration", () => {
    expect(formatScheduleLabel({ kind: "interval", everyMs: 60_000 })).toBe(
      "every 1m",
    );
  });
});

describe("formatIntervalMs", () => {
  it("produces seconds / minutes / hours / days tiers", () => {
    expect(formatIntervalMs(1_000)).toBe("1s");
    expect(formatIntervalMs(60_000)).toBe("1m");
    expect(formatIntervalMs(3_600_000)).toBe("1h");
    expect(formatIntervalMs(86_400_000)).toBe("1d");
  });
});

describe("formatRelativeMs", () => {
  it("`-` for null", () => {
    expect(formatRelativeMs(null, 0)).toBe("-");
  });
  it("`now` for sub-second deltas", () => {
    expect(formatRelativeMs(100, 0)).toBe("now");
  });
  it("prefixes future timestamps with `in`", () => {
    expect(formatRelativeMs(61_000, 0)).toBe("in 1m");
  });
  it("suffixes past timestamps with ` ago`", () => {
    expect(formatRelativeMs(0, 61_000)).toBe("1m ago");
  });
});

describe("toTaskSummaryRow", () => {
  it("condenses long multi-line messages", () => {
    const record: TaskRecord = {
      ...BASE,
      userMessage: "a\nb\tc   d".padEnd(120, "!"),
    };
    const row = toTaskSummaryRow(record);
    expect(row.userMessage.endsWith("…")).toBe(true);
    expect(row.userMessage.includes("\n")).toBe(false);
  });

  it("preserves the schedule kind and label", () => {
    const record: TaskRecord = {
      ...BASE,
      schedule: { kind: "cron", expression: "*/5 * * * *" },
      recurring: true,
    };
    const row = toTaskSummaryRow(record);
    expect(row.scheduleKind).toBe("cron");
    expect(row.scheduleLabel).toBe("cron: */5 * * * *");
    expect(row.recurring).toBe(true);
  });
});

describe("formatUnixMs", () => {
  it("handles finite timestamps deterministically", () => {
    const label = formatUnixMs(1_700_000_000_000);
    expect(label).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });
  it("returns `-` for non-finite values", () => {
    expect(formatUnixMs(Number.NaN)).toBe("-");
  });
});
