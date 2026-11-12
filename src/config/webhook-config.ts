import { ConfigValidationError } from "./config-validation-error.js";
import { parseNonEmptyString } from "./config-primitives.js";
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
 * against the parsed JSON request body, plus `{{event}}`, `{{action}}`
 * and `{{delivery}}` for the signed service schemes.
 *
 * `verify` picks how `secret` authenticates a hit, always in addition to
 * the global API-key check:
 *  - `secret` (default) — `secret`, when set, must equal the
 *    `x-webhook-secret` request header
 *  - `github` — `X-Hub-Signature-256: sha256=<hex HMAC of the raw body>`
 *  - `standard-webhooks` — the Standard Webhooks headers (`webhook-id`,
 *    `webhook-timestamp`, `webhook-signature`) with a `whsec_` secret
 *  - `stripe` — `Stripe-Signature: t=<unix>,v1=<hex HMAC of "<t>.<body>">`
 *    with the endpoint's `whsec_` secret used as-is (ATO-625)
 * The signed schemes require `secret`. `events`, allowed only with a
 * signed scheme, limits which events start a task: a GitHub event name
 * (`pull_request`) or event plus action (`pull_request.opened`), or a
 * Standard Webhooks or Stripe payload `type`.
 */
export type WebhookVerifyScheme = "secret" | "github" | "standard-webhooks" | "stripe";

export interface WebhookConfig {
  userMessageTemplate: string;
  secret?: string;
  verify?: WebhookVerifyScheme;
  events?: string[];
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
    const verify = parseVerifyScheme(cfg.verify, `${field}.${name}.verify`);
    if (verify !== "secret" && !secret) {
      throw new ConfigValidationError(
        `${field}.${name}.secret`,
        `verify=${verify} requires a non-empty secret`,
      );
    }
    if (verify === "standard-webhooks" && secret) {
      assertStandardWebhooksSecret(secret, `${field}.${name}.secret`);
    }
    const events = parseEventFilter(cfg.events, `${field}.${name}.events`);
    if (events && verify === "secret") {
      throw new ConfigValidationError(
        `${field}.${name}.events`,
        "events requires verify=github, verify=standard-webhooks or verify=stripe",
      );
    }
    let schedule: TaskSchedule | undefined;
    if (cfg.schedule !== undefined && cfg.schedule !== null) {
      schedule = parseWebhookSchedule(
        cfg.schedule,
        `${field}.${name}.schedule`,
      );
    }
    out[name] = {
      userMessageTemplate,
      sessionMode,
      ...(sessionId ? { sessionId } : {}),
      ...(secret ? { secret } : {}),
      ...(verify !== "secret" ? { verify } : {}),
      ...(events ? { events } : {}),
      ...(schedule ? { schedule } : {}),
    };
  }
  return out;
}

function parseVerifyScheme(raw: unknown, field: string): WebhookVerifyScheme {
  if (raw === undefined || raw === null) return "secret";
  if (
    raw === "secret" ||
    raw === "github" ||
    raw === "standard-webhooks" ||
    raw === "stripe"
  ) {
    return raw;
  }
  throw new ConfigValidationError(
    field,
    `expected secret|github|standard-webhooks|stripe, got ${JSON.stringify(raw)}`,
  );
}

/** A `whsec_` prefix is optional; what follows must be non-empty base64. */
function assertStandardWebhooksSecret(secret: string, field: string): void {
  const body = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || Buffer.from(body, "base64").length === 0) {
    throw new ConfigValidationError(
      field,
      "verify=standard-webhooks expects a base64 secret such as whsec_<base64>",
    );
  }
}

function parseEventFilter(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigValidationError(
      field,
      "expected a non-empty array of event names",
    );
  }
  return raw.map((entry, i) => parseNonEmptyString(entry, `${field}[${i}]`));
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
