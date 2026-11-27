/**
 * Shared primitives for the Linear channel (ATO-2324).
 *
 * Linear reaches the agent through a workspace webhook: the user creates
 * one in Linear (Settings, API, Webhooks) for Comment and Issue events,
 * points it at a tunnel of their choice, and Linear POSTs every event to
 * `/linear/webhook` with an HMAC-SHA256 `Linear-Signature`. Replies go
 * back through the Linear GraphQL API with a personal API key (or an
 * OAuth token). The same shape as the Cline CLI Linear connector
 * (Apache-2.0, `apps/cli/src/connectors/adapters/linear.ts`): a signed
 * webhook in, `commentCreate` out, no relay of ours in between.
 */

/** Linear personal API key (`lin_api_...`) or OAuth access token. Lives in `<stateDir>/.env`. */
export const LINEAR_API_KEY_KEY = "LINEAR_API_KEY";
/** The webhook's signing secret, shown once in Linear. Lives in `<stateDir>/.env`. */
export const LINEAR_WEBHOOK_SECRET_KEY = "LINEAR_WEBHOOK_SECRET";

/** Default local port, next to the Teams default (3978). */
export const LINEAR_DEFAULT_PORT = 3979;
/** The only path the inbound server answers. */
export const LINEAR_WEBHOOK_PATH = "/linear/webhook";
/** Handle the agent answers to when `options.mention` is not set: `@agent`. */
export const LINEAR_DEFAULT_MENTION = "agent";
/** Linear GraphQL endpoint. */
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/**
 * Longest reply body this channel posts in one comment. Linear has no
 * documented hard cap near this; past it a comment stops being readable
 * in the issue sidebar, so the rest is cut with a note.
 */
export const LINEAR_COMMENT_LIMIT = 30_000;

/**
 * Replace secret-shaped substrings with placeholders. GraphQL and fetch
 * errors can echo the API key, and those strings reach `lastError`, the
 * TUI and the logs.
 */
export function scrubLinearError(err: unknown, secrets: readonly string[] = []): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) {
    if (secret.length >= 6) msg = msg.split(secret).join("<secret>");
  }
  return msg
    .replace(/lin_(api|oauth|wh)_[A-Za-z0-9]+/g, "lin_$1_<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <token>");
}

/** Read one secret, treating blank as "not configured". Explicit wins (test seam). */
export function resolveLinearSecret(
  key: string,
  explicit?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (explicit !== undefined) return explicit;
  const raw = env[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type Options = Record<string, string | number | boolean>;

/** `options.port`: a valid TCP port, else the default. */
export function readLinearPort(options: Options): number {
  const raw = Number(options.port);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : LINEAR_DEFAULT_PORT;
}

/**
 * `options.mention`: the handles that address the agent, comma separated,
 * with or without `@` (`"agent, atomic"`). Defaults to `agent`.
 */
export function readLinearMentions(options: Options): string[] {
  const raw = typeof options.mention === "string" ? options.mention : LINEAR_DEFAULT_MENTION;
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const handle = part.trim().replace(/^@/, "").toLowerCase();
    if (/^[a-z0-9._-]{1,64}$/.test(handle) && !out.includes(handle)) out.push(handle);
  }
  return out.length > 0 ? out : [LINEAR_DEFAULT_MENTION];
}

/** `options.onAssign`: `true` / `false` when set, else `null` (decided at start). */
export function readLinearOnAssign(options: Options): boolean | null {
  return typeof options.onAssign === "boolean" ? options.onAssign : null;
}

/** How Linear reaches the agent: a signed webhook, or polling the API (ATO-2464). */
export type LinearMode = "webhook" | "poll";

export const LINEAR_DEFAULT_POLL_SECONDS = 60;
export const LINEAR_MIN_POLL_SECONDS = 15;
export const LINEAR_MAX_POLL_SECONDS = 3600;

/** `options.mode` when set to `webhook` or `poll`, else `null` (decided at start by the webhook secret). */
export function readLinearMode(options: Options): LinearMode | null {
  return options.mode === "webhook" || options.mode === "poll" ? options.mode : null;
}

/** No explicit mode: webhook when its signing secret is saved, polling otherwise. */
export function resolveLinearMode(explicit: LinearMode | null, hasWebhookSecret: boolean): LinearMode {
  return explicit ?? (hasWebhookSecret ? "webhook" : "poll");
}

/** `options.pollSeconds` clamped to 15..3600, default 60; returned in ms. */
export function readLinearPollMs(options: Options): number {
  const raw = Number(options.pollSeconds);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : LINEAR_DEFAULT_POLL_SECONDS;
  return Math.round(Math.min(LINEAR_MAX_POLL_SECONDS, Math.max(LINEAR_MIN_POLL_SECONDS, seconds)) * 1000);
}

/** A Linear user or app as webhooks carry it. */
export interface LinearActor {
  id?: string;
  name?: string;
  /** `user`, `oauthClient`, `integration`. */
  type?: string;
}

/** `data` of a `Comment` event. Only the fields this channel reads. */
export interface LinearCommentData {
  id?: string;
  body?: string;
  issueId?: string;
  userId?: string;
  /** Set when the comment is a reply inside a thread. */
  parentId?: string | null;
  /** Set when an app (not a person) wrote it. */
  botActor?: unknown;
  issue?: { id?: string; identifier?: string; title?: string };
}

/** `data` of an `Issue` event. Only the fields this channel reads. */
export interface LinearIssueData {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  assigneeId?: string | null;
}

/** One webhook payload. */
export interface LinearWebhookPayload {
  /** `create`, `update`, `remove`. */
  action?: string;
  /** `Comment`, `Issue`, ... */
  type?: string;
  data?: unknown;
  /** Previous values of the fields an `update` changed. */
  updatedFrom?: Record<string, unknown>;
  actor?: LinearActor;
  url?: string;
  /** When Linear sent the delivery, ms since epoch. Checked for freshness. */
  webhookTimestamp?: number;
  webhookId?: string;
  organizationId?: string;
}

/** Where a reply goes: the issue, optionally the top-level comment of a thread. */
export interface LinearTarget {
  issueId: string;
  parentId?: string;
}
