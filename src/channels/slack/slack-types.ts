/**
 * Shared primitives for the Slack channel (ATO-499).
 *
 * Slack is reached over Socket Mode with Node's built-in `fetch` and
 * `WebSocket`, no `@slack/bolt` or `@slack/web-api`: the channel needs
 * four Web API methods and one small envelope protocol, and a client
 * library would add a large dependency tree to a single-file binary.
 * Socket Mode needs no public URL, which is the point for an agent that
 * runs on a laptop.
 */

/** Bot user OAuth token (`xoxb-…`). Lives in `<stateDir>/.env`. */
export const SLACK_BOT_TOKEN_KEY = "SLACK_BOT_TOKEN";
/** App-level token (`xapp-…`) with `connections:write`. Lives in `<stateDir>/.env`. */
export const SLACK_APP_TOKEN_KEY = "SLACK_APP_TOKEN";

export const SLACK_API_BASE = "https://slack.com/api";

/**
 * Longest text this channel puts in one message. Slack accepts far more
 * in `text` but truncates past ~4000 characters in clients; 3500 leaves
 * room for the mrkdwn markers the formatter adds.
 */
export const SLACK_MESSAGE_LIMIT = 3500;

/**
 * Web API error codes no retry will ever fix: the token is wrong,
 * revoked, the wrong kind, or the app lacks a scope. The socket loop
 * stops on these and reports instead of spinning.
 */
export const FATAL_SLACK_ERRORS: ReadonlySet<string> = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "not_allowed_token_type",
  "missing_scope",
  "no_permission",
  "team_access_not_granted",
]);

/** Human cause for the codes an operator can act on. */
export function describeSlackError(code: string): string {
  switch (code) {
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
    case "token_expired":
      return `Slack rejected the token (${code}).`;
    case "not_allowed_token_type":
      return "Slack refused the token type: SLACK_BOT_TOKEN must be xoxb-, SLACK_APP_TOKEN must be xapp-.";
    case "missing_scope":
      return "The Slack app is missing a scope (see the app manifest).";
    default:
      return `Slack returned ${code}.`;
  }
}

/**
 * Replace token-shaped substrings and Socket Mode tickets with
 * placeholders. Fetch and socket errors routinely echo the request URL
 * (the wss URL carries a one-time `ticket`) and those strings reach
 * `lastError`, the TUI and the logs.
 */
export function scrubSlackError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/xox[a-z]-[A-Za-z0-9-]+/g, "<token>")
    .replace(/xapp-[A-Za-z0-9-]+/g, "<token>")
    .replace(/ticket=[^&\s"']+/g, "ticket=<redacted>");
}

/** Read one token, treating blank as "not configured". Explicit wins (test seam). */
export function resolveSlackToken(
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

/** One Socket Mode frame. Only the fields this channel reads. */
export interface SlackEnvelope {
  type: string;
  envelope_id?: string;
  payload?: unknown;
  /** On `disconnect`: `warning`, `refresh_requested`, `link_disabled`. */
  reason?: string;
  retry_attempt?: number;
}

/** A `message` or `app_mention` event. */
export interface SlackMessageEvent {
  type: string;
  channel?: string;
  /** `im` for a DM; `channel`, `group`, `mpim` otherwise. */
  channel_type?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

/** A `block_actions` interactive payload. */
export interface SlackBlockActionsPayload {
  type: string;
  user?: { id?: string };
  channel?: { id?: string };
  container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
  message?: { ts?: string; thread_ts?: string };
  actions?: ReadonlyArray<{ action_id?: string; value?: string }>;
}

/** Where a reply goes: a channel plus, optionally, the thread root. */
export interface SlackTarget {
  channel: string;
  threadTs?: string;
}
