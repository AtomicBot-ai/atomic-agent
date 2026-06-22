import { describe, expect, it } from "vitest";
import { mapOpenclawCronJob } from "./map-cron.js";
import type { OpenclawCronJob } from "./openclaw-source.js";

function job(overrides: Partial<OpenclawCronJob> = {}): OpenclawCronJob {
  return {
    id: "j-1",
    name: "nightly",
    prompt: "summarise the inbox",
    enabled: true,
    scheduleKind: "cron",
    scheduleExpr: "0 9 * * *",
    scheduleTz: null,
    everyMs: null,
    at: null,
    ...overrides,
  };
}

const OPTS = { maxAttempts: 3, now: 1_000_000 };

describe("mapOpenclawCronJob", () => {
  it("maps a cron expression to a cron schedule", () => {
    const result = mapOpenclawCronJob(job(), OPTS);
    expect(result).toMatchObject({
      kind: "task",
      input: {
        userMessage: "summarise the inbox",
        schedule: { kind: "cron", expression: "0 9 * * *" },
      },
    });
  });

  it("carries the timezone when present", () => {
    const result = mapOpenclawCronJob(job({ scheduleTz: "Europe/Berlin" }), OPTS);
    expect(result).toMatchObject({
      kind: "task",
      input: { schedule: { kind: "cron", tz: "Europe/Berlin" } },
    });
  });

  it("maps every_ms to an interval schedule", () => {
    const result = mapOpenclawCronJob(
      job({ scheduleExpr: null, everyMs: 90_000 }),
      OPTS,
    );
    expect(result).toMatchObject({
      kind: "task",
      input: { schedule: { kind: "interval", everyMs: 90_000 } },
    });
  });

  it("maps a future `at` to an at schedule", () => {
    const future = new Date(OPTS.now + 60_000).toISOString();
    const result = mapOpenclawCronJob(
      job({ scheduleExpr: null, at: future }),
      OPTS,
    );
    expect(result).toMatchObject({
      kind: "task",
      input: { schedule: { kind: "at", at: OPTS.now + 60_000 } },
    });
  });

  it("skips a one-shot scheduled in the past", () => {
    const past = new Date(OPTS.now - 60_000).toISOString();
    const result = mapOpenclawCronJob(
      job({ scheduleExpr: null, at: past }),
      OPTS,
    );
    expect(result).toEqual({ kind: "skip", reason: "one-shot scheduled in the past" });
  });

  it("skips a disabled job", () => {
    expect(mapOpenclawCronJob(job({ enabled: false }), OPTS)).toEqual({
      kind: "skip",
      reason: "disabled",
    });
  });

  it("skips an empty prompt", () => {
    expect(mapOpenclawCronJob(job({ prompt: "   " }), OPTS)).toEqual({
      kind: "skip",
      reason: "empty prompt",
    });
  });

  it("skips when no schedule field is populated", () => {
    const result = mapOpenclawCronJob(
      job({ scheduleKind: "weird", scheduleExpr: null }),
      OPTS,
    );
    expect(result).toEqual({
      kind: "skip",
      reason: "unsupported schedule (kind: weird)",
    });
  });
});
