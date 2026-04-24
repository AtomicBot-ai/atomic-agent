import { describe, it, expect } from "vitest";

import { TaskValidationError } from "./task-types.js";
import {
  SCHEDULE_AT_MAX_AHEAD_MS,
  SCHEDULE_INTERVAL_MIN_MS,
  isRecurring,
  parseScheduleRow,
  resolveScheduledFor,
  serializeScheduleValue,
  validateSchedule,
} from "./task-schedule.js";

describe("isRecurring", () => {
  it("treats null as non-recurring", () => {
    expect(isRecurring(null)).toBe(false);
  });

  it("treats at as non-recurring", () => {
    expect(isRecurring({ kind: "at", at: 1 })).toBe(false);
  });

  it("treats cron and interval as recurring", () => {
    expect(isRecurring({ kind: "cron", expression: "* * * * *" })).toBe(true);
    expect(isRecurring({ kind: "interval", everyMs: 1_000 })).toBe(true);
  });
});

describe("resolveScheduledFor", () => {
  const NOW = new Date("2026-04-24T12:00:00Z").getTime();

  it("returns the wall-clock ms for at schedules (including past ones)", () => {
    expect(resolveScheduledFor({ kind: "at", at: NOW + 60_000 }, NOW)).toBe(
      NOW + 60_000,
    );
    expect(resolveScheduledFor({ kind: "at", at: NOW - 60_000 }, NOW)).toBe(
      NOW - 60_000,
    );
  });

  it("advances interval schedules by everyMs", () => {
    expect(
      resolveScheduledFor({ kind: "interval", everyMs: 30_000 }, NOW),
    ).toBe(NOW + 30_000);
  });

  it("advances cron schedules to the next firing strictly after fromMs", () => {
    const next = resolveScheduledFor(
      { kind: "cron", expression: "*/5 * * * *", tz: "UTC" },
      NOW,
    );
    expect(next).toBe(new Date("2026-04-24T12:05:00Z").getTime());
  });

  it("respects the tz option when resolving cron", () => {
    const next = resolveScheduledFor(
      { kind: "cron", expression: "0 9 * * *", tz: "Europe/Berlin" },
      new Date("2026-04-24T00:00:00Z").getTime(),
    );
    expect(new Date(next).toISOString()).toBe("2026-04-24T07:00:00.000Z");
  });

  it("rejects intervals below the minimum", () => {
    expect(() =>
      resolveScheduledFor({ kind: "interval", everyMs: 100 }, NOW),
    ).toThrowError(TaskValidationError);
  });

  it("rejects at values too far in the future", () => {
    expect(() =>
      resolveScheduledFor(
        { kind: "at", at: NOW + SCHEDULE_AT_MAX_AHEAD_MS + 1 },
        NOW,
      ),
    ).toThrowError(TaskValidationError);
  });

  it("rejects invalid cron expressions", () => {
    expect(() =>
      resolveScheduledFor({ kind: "cron", expression: "not-a-cron" }, NOW),
    ).toThrowError(TaskValidationError);
  });
});

describe("validateSchedule", () => {
  const NOW = Date.now();

  it("accepts a minimal valid interval", () => {
    expect(() =>
      validateSchedule({ kind: "interval", everyMs: SCHEDULE_INTERVAL_MIN_MS }, NOW),
    ).not.toThrow();
  });

  it("rejects unknown kinds", () => {
    expect(() =>
      // @ts-expect-error: intentionally bad payload
      validateSchedule({ kind: "weekly" }, NOW),
    ).toThrowError(TaskValidationError);
  });

  it("rejects non-string cron expressions", () => {
    expect(() =>
      // @ts-expect-error: intentionally bad payload
      validateSchedule({ kind: "cron", expression: 42 }, NOW),
    ).toThrowError(TaskValidationError);
  });

  it("rejects cron expressions longer than the hard cap", () => {
    const longExpr = "* ".repeat(120);
    expect(() =>
      validateSchedule({ kind: "cron", expression: longExpr }, NOW),
    ).toThrowError(TaskValidationError);
  });

  it("rejects non-string tz on cron", () => {
    expect(() =>
      validateSchedule(
        // @ts-expect-error: intentionally bad payload
        { kind: "cron", expression: "* * * * *", tz: 42 },
        NOW,
      ),
    ).toThrowError(TaskValidationError);
  });
});

describe("serialize/parse round-trip", () => {
  it("preserves at schedules", () => {
    const schedule = { kind: "at" as const, at: 1_700_000_000_000 };
    const rebuilt = parseScheduleRow("at", serializeScheduleValue(schedule));
    expect(rebuilt).toEqual(schedule);
  });

  it("preserves interval schedules", () => {
    const schedule = { kind: "interval" as const, everyMs: 60_000 };
    const rebuilt = parseScheduleRow(
      "interval",
      serializeScheduleValue(schedule),
    );
    expect(rebuilt).toEqual(schedule);
  });

  it("preserves cron schedules with tz", () => {
    const schedule = {
      kind: "cron" as const,
      expression: "0 9 * * *",
      tz: "Europe/Berlin",
    };
    const rebuilt = parseScheduleRow("cron", serializeScheduleValue(schedule));
    expect(rebuilt).toEqual(schedule);
  });

  it("preserves cron schedules without tz", () => {
    const schedule = { kind: "cron" as const, expression: "*/5 * * * *" };
    const rebuilt = parseScheduleRow("cron", serializeScheduleValue(schedule));
    expect(rebuilt).toEqual(schedule);
  });

  it("returns null for empty inputs", () => {
    expect(parseScheduleRow(null, null)).toBeNull();
    expect(parseScheduleRow("cron", null)).toBeNull();
  });
});
