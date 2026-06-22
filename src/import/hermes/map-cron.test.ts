import { describe, expect, it } from "vitest";
import { mapHermesCronJob } from "./map-cron.js";
import type { HermesCronJob } from "./hermes-source.js";

const NOW = Date.parse("2026-06-22T12:00:00Z");

function job(overrides: Partial<HermesCronJob> = {}): HermesCronJob {
  return {
    id: "j-1",
    name: "test",
    prompt: "do the thing",
    enabled: true,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    ...overrides,
  };
}

describe("mapHermesCronJob", () => {
  it("maps a cron schedule", () => {
    const result = mapHermesCronJob(job(), { maxAttempts: 3, now: NOW });
    expect(result.kind).toBe("task");
    if (result.kind !== "task") return;
    expect(result.input.schedule).toEqual({
      kind: "cron",
      expression: "0 9 * * *",
    });
    expect(result.input.userMessage).toBe("do the thing");
    expect(result.input.origin).toBe("cli");
    expect(result.input.triggerSource).toBe("user");
    expect(result.input.maxAttempts).toBe(3);
    expect(result.input.sessionId).toBeNull();
  });

  it("maps an interval schedule (minutes -> everyMs)", () => {
    const result = mapHermesCronJob(
      job({ schedule: { kind: "interval", minutes: 30 } }),
      { maxAttempts: 3, now: NOW },
    );
    expect(result.kind).toBe("task");
    if (result.kind !== "task") return;
    expect(result.input.schedule).toEqual({
      kind: "interval",
      everyMs: 1_800_000,
    });
  });

  it("maps a future one-shot to an 'at' schedule", () => {
    const runAt = "2026-06-23T09:00:00Z";
    const result = mapHermesCronJob(
      job({ schedule: { kind: "once", run_at: runAt } }),
      { maxAttempts: 3, now: NOW },
    );
    expect(result.kind).toBe("task");
    if (result.kind !== "task") return;
    expect(result.input.schedule).toEqual({
      kind: "at",
      at: Date.parse(runAt),
    });
  });

  it("skips a past one-shot", () => {
    const result = mapHermesCronJob(
      job({ schedule: { kind: "once", run_at: "2020-01-01T00:00:00Z" } }),
      { maxAttempts: 3, now: NOW },
    );
    expect(result).toEqual({ kind: "skip", reason: "one-shot scheduled in the past" });
  });

  it("skips a disabled job", () => {
    const result = mapHermesCronJob(job({ enabled: false }), {
      maxAttempts: 3,
      now: NOW,
    });
    expect(result).toEqual({ kind: "skip", reason: "disabled" });
  });

  it("skips an empty prompt", () => {
    const result = mapHermesCronJob(job({ prompt: "   " }), {
      maxAttempts: 3,
      now: NOW,
    });
    expect(result).toEqual({ kind: "skip", reason: "empty prompt" });
  });

  it("skips an unparseable run_at", () => {
    const result = mapHermesCronJob(
      job({ schedule: { kind: "once", run_at: "not-a-date" } }),
      { maxAttempts: 3, now: NOW },
    );
    expect(result.kind).toBe("skip");
    if (result.kind !== "skip") return;
    expect(result.reason).toContain("unparseable run_at");
  });

  it("skips an unsupported schedule kind", () => {
    const result = mapHermesCronJob(
      job({ schedule: { kind: "weekly" } }),
      { maxAttempts: 3, now: NOW },
    );
    expect(result.kind).toBe("skip");
    if (result.kind !== "skip") return;
    expect(result.reason).toContain("unsupported schedule kind");
  });
});
