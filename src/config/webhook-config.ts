import { ConfigValidationError } from "./config-validation-error.js";
import { parseNonEmptyString } from "./config-primitives.js";
import {
  parseEmailTriggerConfig,
  type EmailTriggerConfig,
} from "./email-trigger-config.js";
import type { TaskSchedule } from "../tasks/task-types.js";

/**
 * Declarative binding between an inbound webhook URL path and the task
 * it materialises. Per-webhook config lets operators point external
 * systems (e.g. a GitHub hook, a cron-like SaaS) at atomic-agent
 * without writing code — the HTTP layer turns each hit into a task.
 *
 * `sessionMode` drives session continuity across repeated hits:
 *  - `ephemeral`   — fresh ephemeral session per hit (default when no
 *    schedule is set; matches CLI one-shot behaviour)
 *  - `persistent`  — a single session created on the first hit and
 *    reused forever; sessionId persisted in
 *    `<stateDir>/webhook-sessions.json` keyed by webhook name
 *  - `named`       — explicit `sessionId` supplied by the operator; no
 *    persistence file, no auto-creation
 *
 * `userMessageTemplate` supports `{{body.<json.path>}}` placeholders
 * against the parsed JSON request body. `secret`, when set, is
 * matched against the `x-webhook-secret` request header in addition
 * to the global API-key check.
 *
 * `source` picks what fires the binding (ATO-601): `"http"` (the
 * default) is `POST /api/webhooks/<name>`; `"atomic-mail"` is a new
 * message in the agent's own inbox from a sender in
 * `email.allowedSenders` (see `email-trigger-config.ts`). A mail
 * binding is never reachable over HTTP, and its template only sees
 * `{{body.from}}` and `{{body.receivedAt}}`: the subject and text are
 * appended below it as fenced, untrusted data.
 */
export interface WebhookConfig {
  userMessageTemplate: string;
  source?: "http" | "atomic-mail";
  email?: EmailTriggerConfig;
  secret?: string;
  schedule?: TaskSchedule;
  sessionMode?: "ephemeral" | "persistent" | "named";
  sessionId?: string;
}

/**
 * Validate and normalise the keyed `webhooks` block. The schedule,
 * when supplied, is left as raw JSON here (cron/interval/at) — it's
 * passed to `TaskRunner.create` at dispatch time where
 * `validateSchedule` runs canonically. This keeps config parsing
 * decoupled from cron-parser, which lives behind `task-schedule.ts`.
 */
export function parseWebhookMap(
  raw: unknown,
  field: string,
): Record<string, WebhookConfig> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected object, got ${JSON.stringify(raw)}`,
    );
  }
  const out: Record<string, WebhookConfig> = {};
  for (const [name, rawCfg] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new ConfigValidationError(
        `${field}.${name}`,
        "webhook name must match [a-zA-Z0-9_-]+",
      );
    }
    if (
      rawCfg === null ||
      typeof rawCfg !== "object" ||
      Array.isArray(rawCfg)
    ) {
      throw new ConfigValidationError(
        `${field}.${name}`,
        `expected object, got ${JSON.stringify(rawCfg)}`,
      );
    }
    const cfg = rawCfg as Record<string, unknown>;
    const userMessageTemplate = parseNonEmptyString(
      cfg.userMessageTemplate,
      `${field}.${name}.userMessageTemplate`,
    );
    const sessionMode = cfg.sessionMode ?? "ephemeral";
    if (
      sessionMode !== "ephemeral" &&
      sessionMode !== "persistent" &&
      sessionMode !== "named"
    ) {
      throw new ConfigValidationError(
        `${field}.${name}.sessionMode`,
        `expected ephemeral|persistent|named, got ${JSON.stringify(sessionMode)}`,
      );
    }
    let sessionId: string | undefined;
    if (cfg.sessionId !== undefined && cfg.sessionId !== null) {
      sessionId = parseNonEmptyString(
        cfg.sessionId,
        `${field}.${name}.sessionId`,
      );
    }
    if (sessionMode === "named" && !sessionId) {
      throw new ConfigValidationError(
        `${field}.${name}.sessionId`,
        "sessionMode=named requires a non-empty sessionId",
      );
    }
    let secret: string | undefined;
    if (cfg.secret !== undefined && cfg.secret !== null) {
      secret = parseNonEmptyString(cfg.secret, `${field}.${name}.secret`);
    }
    let schedule: TaskSchedule | undefined;
    if (cfg.schedule !== undefined && cfg.schedule !== null) {
      schedule = parseWebhookSchedule(
        cfg.schedule,
        `${field}.${name}.schedule`,
      );
    }
    const source = cfg.source ?? "http";
    if (source !== "http" && source !== "atomic-mail") {
      throw new ConfigValidationError(
        `${field}.${name}.source`,
        `expected http|atomic-mail, got ${JSON.stringify(source)}`,
      );
    }
    let email: EmailTriggerConfig | undefined;
    if (source === "atomic-mail") {
      email = parseEmailTriggerConfig(cfg.email, `${field}.${name}.email`);
    } else if (cfg.email !== undefined && cfg.email !== null) {
      throw new ConfigValidationError(
        `${field}.${name}.email`,
        'only allowed with source "atomic-mail"',
      );
    }
    if (source === "atomic-mail" && schedule) {
      throw new ConfigValidationError(
        `${field}.${name}.schedule`,
        'not allowed with source "atomic-mail": each mail is one task',
      );
    }
    out[name] = {
      userMessageTemplate,
      ...(source === "atomic-mail" ? { source, email } : {}),
      sessionMode,
      ...(sessionId ? { sessionId } : {}),
      ...(secret ? { secret } : {}),
      ...(schedule ? { schedule } : {}),
    };
  }
  return out;
}

function parseWebhookSchedule(raw: unknown, field: string): TaskSchedule {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected schedule object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind === "at") {
    const at = obj.at;
    if (typeof at !== "number" || !Number.isFinite(at)) {
      throw new ConfigValidationError(
        `${field}.at`,
        "expected finite number (Unix ms)",
      );
    }
    return { kind: "at", at };
  }
  if (obj.kind === "interval") {
    const everyMs = obj.everyMs;
    if (
      typeof everyMs !== "number" ||
      !Number.isInteger(everyMs) ||
      everyMs <= 0
    ) {
      throw new ConfigValidationError(
        `${field}.everyMs`,
        "expected positive integer",
      );
    }
    return { kind: "interval", everyMs };
  }
  if (obj.kind === "cron") {
    const expression = parseNonEmptyString(
      obj.expression,
      `${field}.expression`,
    );
    const tz = typeof obj.tz === "string" ? obj.tz : undefined;
    return { kind: "cron", expression, ...(tz ? { tz } : {}) };
  }
  throw new ConfigValidationError(
    `${field}.kind`,
    `expected at|cron|interval, got ${JSON.stringify(obj.kind)}`,
  );
}
