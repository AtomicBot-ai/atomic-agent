/**
 * Shared primitives for the Microsoft Teams channel (ATO-506).
 *
 * Teams reaches a bot only through the Bot Framework: the user registers
 * their own Azure Bot (App ID + client secret), points its messaging
 * endpoint at a tunnel of their choice, and Bot Framework POSTs
 * activities to `/api/messages`. We speak that REST protocol directly
 * with Node built-ins (`node:http`, `node:crypto`, `fetch`) instead of
 * `@microsoft/teams.apps`: the channel needs one inbound route, JWT
 * checks and three outbound calls, and a client SDK would add a large
 * dependency tree to a single-file binary. No relay of ours sits in
 * between.
 */

/** Azure Bot "Microsoft App ID" (a GUID). Lives in `<stateDir>/.env`. */
export const MSTEAMS_APP_ID_KEY = "MSTEAMS_APP_ID";
/** The client secret of that app registration. Lives in `<stateDir>/.env`. */
export const MSTEAMS_APP_PASSWORD_KEY = "MSTEAMS_APP_PASSWORD";

/** Default local port, the Bot Framework samples' convention. */
export const MSTEAMS_DEFAULT_PORT = 3978;
/** The only path the inbound server answers. */
export const MSTEAMS_MESSAGES_PATH = "/api/messages";

/**
 * Longest text this channel puts in one message. Teams accepts ~28 KB
 * per activity, but a 20 000-character wall is unreadable on a phone;
 * 4000 keeps each bubble scannable.
 */
export const MSTEAMS_MESSAGE_LIMIT = 4000;

/**
 * Replace secret-shaped substrings with placeholders. Token endpoint and
 * fetch errors can echo the bearer token or the client secret, and those
 * strings reach `lastError`, the TUI and the logs.
 */
export function scrubTeamsError(err: unknown, secrets: readonly string[] = []): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) {
    if (secret.length >= 6) msg = msg.split(secret).join("<secret>");
  }
  return msg
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <token>")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "<token>")
    .replace(/client_secret=[^&\s"']+/g, "client_secret=<redacted>");
}

/** Read one secret, treating blank as "not configured". Explicit wins (test seam). */
export function resolveTeamsSecret(
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

/** `options.port`: a valid TCP port, else the default. */
export function readTeamsPort(options: Record<string, string | number | boolean>): number {
  const raw = Number(options.port);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : MSTEAMS_DEFAULT_PORT;
}

/** `options.tenantId`: a single-tenant app's directory id, else `null` (multi-tenant). */
export function readTeamsTenantId(options: Record<string, string | number | boolean>): string | null {
  const raw = options.tenantId;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return /^[A-Za-z0-9.-]{1,64}$/.test(trimmed) ? trimmed : null;
}

/** One `channelAccount`. */
export interface TeamsAccount {
  id?: string;
  name?: string;
  /** The user's Entra (AAD) object id; the owner allowlist matches on it. */
  aadObjectId?: string;
}

/** One Bot Framework activity. Only the fields this channel reads. */
export interface TeamsActivity {
  type?: string;
  id?: string;
  /** `msteams` for Teams; checked against the signing key's endorsements. */
  channelId?: string;
  serviceUrl?: string;
  text?: string;
  textFormat?: string;
  /** The payload of an Adaptive Card `Action.Submit`. */
  value?: unknown;
  replyToId?: string;
  from?: TeamsAccount;
  recipient?: TeamsAccount;
  conversation?: {
    id?: string;
    /** `personal`, `groupChat` or `channel`. */
    conversationType?: string;
    tenantId?: string;
  };
  entities?: ReadonlyArray<{
    type?: string;
    text?: string;
    mentioned?: TeamsAccount;
  }>;
}

/** Where a reply goes: the service, the conversation, optionally the message replied to. */
export interface TeamsTarget {
  serviceUrl: string;
  conversationId: string;
  replyToId?: string;
}
