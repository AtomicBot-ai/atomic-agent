import { describe, expect, it } from "vitest";
import { createEmptyCreateForm } from "./tasks-panel-state.js";
import { validateCreateForm } from "./tasks-form-validator.js";

const NOW = Date.UTC(2026, 3, 24, 10, 0, 0);

describe("validateCreateForm", () => {
  it("rejects an empty message", () => {
    const form = {
      ...createEmptyCreateForm("cron"),
      message: "",
    };
    const result = validateCreateForm(form, NOW);
    expect(result.schedule).toBeNull();
    expect(result.preview.ok).toBe(false);
    expect(result.preview.error).toMatch(/message/i);
  });

  it("accepts a valid cron expression and populates next-firings", () => {
    const form = {
      ...createEmptyCreateForm("cron"),
      cronExpression: "0 * * * *",
      message: "ping",
    };
    const result = validateCreateForm(form, NOW);
    expect(result.schedule).not.toBeNull();
    expect(result.preview.ok).toBe(true);
    expect(result.preview.nextFirings).toHaveLength(5);
    expect(result.message).toBe("ping");
  });

  it("rejects an invalid cron expression with a cron-parser error", () => {
    const form = {
      ...createEmptyCreateForm("cron"),
      cronExpression: "totally broken",
      message: "ping",
    };
    const result = validateCreateForm(form, NOW);
    expect(result.schedule).toBeNull();
    expect(result.preview.error).toMatch(/cron/i);
  });

  it("parses interval as positive seconds and rejects floats", () => {
    const ok = {
      ...createEmptyCreateForm("interval"),
      intervalSeconds: "300",
      message: "poll",
    };
    const okResult = validateCreateForm(ok, NOW);
    expect(okResult.schedule).toEqual({ kind: "interval", everyMs: 300_000 });

    const bad = {
      ...createEmptyCreateForm("interval"),
      intervalSeconds: "3.5",
      message: "poll",
    };
    expect(validateCreateForm(bad, NOW).schedule).toBeNull();
  });

  it("parses at-schedules from both ISO strings and Unix-ms", () => {
    const iso = {
      ...createEmptyCreateForm("at"),
      atIsoOrMs: "2026-05-01T09:00:00Z",
      message: "wakeup",
    };
    const isoResult = validateCreateForm(iso, NOW);
    expect(isoResult.schedule).toEqual({
      kind: "at",
      at: Date.parse("2026-05-01T09:00:00Z"),
    });

    const ms = {
      ...createEmptyCreateForm("at"),
      atIsoOrMs: `${NOW + 60_000}`,
      message: "wakeup",
    };
    const msResult = validateCreateForm(ms, NOW);
    expect(msResult.schedule).toEqual({ kind: "at", at: NOW + 60_000 });
  });
});
