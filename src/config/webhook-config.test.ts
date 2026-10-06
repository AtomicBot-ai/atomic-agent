import { describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  parseUserConfigFile,
  parseWebhookMap as parseComposedWebhookMap,
  USER_CONFIG_DEFAULTS,
} from "./config-schema.js";
import { ConfigValidationError as OwnedValidationError } from "./config-validation-error.js";
import { parseWebhookMap, type WebhookConfig } from "./webhook-config.js";
import { validateSchedule } from "../tasks/task-schedule.js";
import { TaskValidationError, type TaskSchedule } from "../tasks/task-types.js";

function parsedHook(raw: unknown): WebhookConfig {
  const hook = parseWebhookMap({ ping: raw }, "webhooks").ping;
  if (hook === undefined) throw new Error("parsed webhook fixture is missing");
  return hook;
}

function parsedSchedule(schedule: unknown): TaskSchedule {
  const parsed = parsedHook({ userMessageTemplate: "synthetic tick", schedule }).schedule;
  if (parsed === undefined) throw new Error("parsed schedule fixture is missing");
  return parsed;
}

function thrownError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected webhook validation to reject the fixture");
}

describe("webhook config owner and normalization", () => {
  it("keeps the composing API's function and validation-error identity", () => {
    expect(parseComposedWebhookMap).toBe(parseWebhookMap);
    expect(ConfigValidationError).toBe(OwnedValidationError);
  });

  it("assembles normalized webhooks through the whole-file parser", () => {
    const raw = {
      ping: { userMessageTemplate: "hello {{body.who}}" },
      named: {
        userMessageTemplate: "synthetic named event",
        sessionMode: "named",
        sessionId: "fixture-session",
        secret: "synthetic-webhook-secret",
      },
    };
    const parsed = parseUserConfigFile({ ...USER_CONFIG_DEFAULTS, webhooks: raw });
    expect(parsed.webhooks).toStrictEqual(parseWebhookMap(raw, "webhooks"));
    expect(parsed.webhooks).toStrictEqual({
      ping: { userMessageTemplate: "hello {{body.who}}", sessionMode: "ephemeral" },
      named: {
        userMessageTemplate: "synthetic named event",
        sessionMode: "named",
        sessionId: "fixture-session",
        secret: "synthetic-webhook-secret",
      },
    });
  });

  it.each([undefined, null, {}])("normalizes an absent or empty map %j", (raw) => {
    expect(parseWebhookMap(raw, "webhooks")).toStrictEqual({});
  });

  it("omits optional null fields rather than serializing them as undefined", () => {
    expect(parsedHook({
      userMessageTemplate: "synthetic event",
      sessionMode: null,
      sessionId: null,
      secret: null,
      schedule: null,
    })).toStrictEqual({
      userMessageTemplate: "synthetic event",
      sessionMode: "ephemeral",
    });
  });

  it("retains supported URL names and nonempty whitespace without trimming", () => {
    expect(parseWebhookMap({
      "Hook_9-test": {
        userMessageTemplate: "   ",
        sessionMode: "named",
        sessionId: " ",
        secret: " synthetic secret ",
      },
    }, "webhooks")).toStrictEqual({
      "Hook_9-test": {
        userMessageTemplate: "   ",
        sessionMode: "named",
        sessionId: " ",
        secret: " synthetic secret ",
      },
    });
  });

  it("preserves explicit persistent session mode", () => {
    expect(parsedHook({
      userMessageTemplate: "synthetic persistent event",
      sessionMode: "persistent",
    })).toStrictEqual({
      userMessageTemplate: "synthetic persistent event",
      sessionMode: "persistent",
    });
  });
});

describe("webhook config field errors", () => {
  const cases = [
    {
      label: "map shape",
      raw: [],
      field: "ingress",
      reason: "expected object, got []",
    },
    {
      label: "entry shape",
      raw: { ping: null },
      field: "ingress.ping",
      reason: "expected object, got null",
    },
    {
      label: "URL name",
      raw: { "bad.name": { userMessageTemplate: "synthetic event" } },
      field: "ingress.bad.name",
      reason: "webhook name must match [a-zA-Z0-9_-]+",
    },
    {
      label: "empty message",
      raw: { ping: { userMessageTemplate: "" } },
      field: "ingress.ping.userMessageTemplate",
      reason: 'expected non-empty string, got ""',
    },
    {
      label: "unknown session mode",
      raw: { ping: { userMessageTemplate: "event", sessionMode: "fresh" } },
      field: "ingress.ping.sessionMode",
      reason: 'expected ephemeral|persistent|named, got "fresh"',
    },
    {
      label: "named mode without a session",
      raw: { ping: { userMessageTemplate: "event", sessionMode: "named" } },
      field: "ingress.ping.sessionId",
      reason: "sessionMode=named requires a non-empty sessionId",
    },
    {
      label: "explicit empty session id",
      raw: { ping: { userMessageTemplate: "event", sessionId: "" } },
      field: "ingress.ping.sessionId",
      reason: 'expected non-empty string, got ""',
    },
    {
      label: "explicit empty secret",
      raw: { ping: { userMessageTemplate: "event", secret: "" } },
      field: "ingress.ping.secret",
      reason: 'expected non-empty string, got ""',
    },
    {
      label: "nonfinite at timestamp",
      raw: { ping: { userMessageTemplate: "event", schedule: { kind: "at", at: Infinity } } },
      field: "ingress.ping.schedule.at",
      reason: "expected finite number (Unix ms)",
    },
    {
      label: "fractional interval",
      raw: { ping: { userMessageTemplate: "event", schedule: { kind: "interval", everyMs: 1.5 } } },
      field: "ingress.ping.schedule.everyMs",
      reason: "expected positive integer",
    },
    {
      label: "empty cron expression",
      raw: { ping: { userMessageTemplate: "event", schedule: { kind: "cron", expression: "" } } },
      field: "ingress.ping.schedule.expression",
      reason: 'expected non-empty string, got ""',
    },
  ];

  it.each(cases)("preserves the exact field and message for $label", ({ raw, field, reason }) => {
    const error = thrownError(() => parseWebhookMap(raw, "ingress"));
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error).toMatchObject({
      field,
      reason,
      name: "ConfigValidationError",
      message: `invalid config: ${field}: ${reason}`,
    });
  });
});

describe("webhook schedule shape versus dispatch policy", () => {
  it.each<TaskSchedule>([
    { kind: "at", at: 1_700_000_000_000 },
    { kind: "interval", everyMs: 5_000 },
    { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
  ])("retains the $kind schedule shape without changing the default session mode", (schedule) => {
    const hook = parsedHook({ userMessageTemplate: "synthetic tick", schedule });
    expect(hook).toStrictEqual({
      userMessageTemplate: "synthetic tick",
      sessionMode: "ephemeral",
      schedule,
    });
  });

  it.each([undefined, "", 123])("omits a nonstring or empty cron timezone %j", (tz) => {
    expect(parsedSchedule({ kind: "cron", expression: "0 9 * * *", tz })).toStrictEqual({
      kind: "cron",
      expression: "0 9 * * *",
    });
  });

  it("leaves the dispatch interval floor to the task scheduler", () => {
    const schedule = parsedSchedule({ kind: "interval", everyMs: 1 });
    expect(schedule).toStrictEqual({ kind: "interval", everyMs: 1 });
    const error = thrownError(() => validateSchedule(schedule, 1_700_000_000_000));
    expect(error).toBeInstanceOf(TaskValidationError);
    expect(error).toMatchObject({ field: "schedule", message: "schedule.everyMs must be >= 1000" });
  });

  it("leaves cron syntax validation to task dispatch", () => {
    const schedule = parsedSchedule({ kind: "cron", expression: "not a cron" });
    expect(schedule).toStrictEqual({ kind: "cron", expression: "not a cron" });
    const error = thrownError(() => validateSchedule(schedule, 1_700_000_000_000));
    expect(error).toBeInstanceOf(TaskValidationError);
    expect(error).toMatchObject({ field: "schedule" });
    if (!(error instanceof Error)) throw new Error("expected task validation error");
    expect(error.message).toMatch(/^invalid cron expression:/);
  });
});
