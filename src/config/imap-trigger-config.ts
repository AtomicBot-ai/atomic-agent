import { ConfigValidationError } from "./config-validation-error.js";

/**
 * The `imap` block of a webhook binding whose `source` is `"imap"`
 * (ATO-601): the operator's own mailbox (Gmail with an app password,
 * Fastmail, iCloud, any IMAP server) fires the binding, the same way a
 * new message in the agent's Atomic Mail inbox does for
 * `source: "atomic-mail"`. The sender rules (`email.allowedSenders`,
 * `email.trustFromHeader`) are the `email` block's; this block only
 * says how to reach the mailbox.
 *
 *  - `host` — required. Implicit TLS only (`port` defaults to 993);
 *    plain IMAP and STARTTLS are refused.
 *  - `user` — required, the login name (usually the address).
 *  - `auth` — `"login"` (password or app password, the default) or
 *    `"xoauth2"` (an OAuth access token the operator obtained
 *    elsewhere; this block never runs an OAuth flow).
 *  - `passwordEnv` — the environment variable holding the password or
 *    token (from `~/.atomic-agent/.env` or the shell). `password` may
 *    hold it inline instead; the variable wins when both are set.
 *  - `mailbox` — the folder watched, `INBOX` by default.
 *  - `idle` — keep one connection open and wait for new mail with IMAP
 *    IDLE (push) instead of only polling. On by default; the server's
 *    lack of IDLE, or a dropped connection, falls back to polling every
 *    `email.pollIntervalMs`.
 *  - `markSeen` — mark the mail that became a task as read. On by
 *    default. Mail that is ignored is never touched.
 *  - `authservId` — when set, the topmost `Authentication-Results`
 *    header must carry exactly this authserv-id (Gmail: `mx.google.com`,
 *    filled in for `imap.gmail.com` when left out), as Hermes requires.
 *  - `attachments` — `save` (default on), `maxCount` (10), `maxBytes`
 *    per file (10 MB) and `maxTotalBytes` per mail (25 MB). Executable
 *    and script types are never saved.
 */
export interface ImapTriggerConfig {
  host: string;
  port: number;
  user: string;
  auth: "login" | "xoauth2";
  passwordEnv?: string;
  password?: string;
  mailbox: string;
  idle: boolean;
  markSeen: boolean;
  authservId?: string;
  attachments: ImapAttachmentLimits;
}

export interface ImapAttachmentLimits {
  save: boolean;
  maxCount: number;
  maxBytes: number;
  maxTotalBytes: number;
}

export const IMAP_DEFAULT_PORT = 993;
export const IMAP_ATTACHMENT_DEFAULTS: ImapAttachmentLimits = {
  save: true,
  maxCount: 10,
  maxBytes: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
};
/** Hard ceiling on `maxTotalBytes`: a whole mail is held in memory. */
export const IMAP_ATTACHMENT_TOTAL_CEILING = 50 * 1024 * 1024;

/** The authserv-id a known provider stamps on its topmost header. */
const KNOWN_AUTHSERV_IDS: Readonly<Record<string, string>> = {
  "imap.gmail.com": "mx.google.com",
};

const HOST_PATTERN = /^[a-z0-9.-]+$/i;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function optionalBool(raw: unknown, fallback: boolean, field: string): boolean {
  const value = raw ?? fallback;
  if (typeof value !== "boolean") throw new ConfigValidationError(field, "expected true or false");
  return value;
}

function positiveInt(raw: unknown, fallback: number, field: string, max = Number.MAX_SAFE_INTEGER): number {
  const value = raw ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new ConfigValidationError(field, `expected an integer between 1 and ${max}`);
  }
  return value;
}

function plainString(raw: unknown, field: string, what: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0 || CONTROL.test(raw)) {
    throw new ConfigValidationError(field, `expected ${what}`);
  }
  return raw.trim();
}

export function parseImapTriggerConfig(raw: unknown, field: string): ImapTriggerConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, 'source "imap" needs an imap block with host and user');
  }
  const obj = raw as Record<string, unknown>;
  const host = plainString(obj.host, `${field}.host`, "a host name").toLowerCase();
  if (!HOST_PATTERN.test(host)) {
    throw new ConfigValidationError(`${field}.host`, `expected a host name, got ${JSON.stringify(obj.host)}`);
  }
  if (obj.tls === false || obj.starttls === true) {
    throw new ConfigValidationError(`${field}.tls`, "only implicit TLS (port 993) is supported");
  }
  const port = positiveInt(obj.port, IMAP_DEFAULT_PORT, `${field}.port`, 65_535);
  const user = plainString(obj.user, `${field}.user`, "the login name");
  const auth = obj.auth ?? "login";
  if (auth !== "login" && auth !== "xoauth2") {
    throw new ConfigValidationError(`${field}.auth`, `expected login|xoauth2, got ${JSON.stringify(auth)}`);
  }
  let passwordEnv: string | undefined;
  if (obj.passwordEnv !== undefined && obj.passwordEnv !== null) {
    if (typeof obj.passwordEnv !== "string" || !ENV_PATTERN.test(obj.passwordEnv)) {
      throw new ConfigValidationError(`${field}.passwordEnv`, "expected an environment variable name");
    }
    passwordEnv = obj.passwordEnv;
  }
  let password: string | undefined;
  if (obj.password !== undefined && obj.password !== null) {
    if (typeof obj.password !== "string" || obj.password.length === 0 || CONTROL.test(obj.password)) {
      throw new ConfigValidationError(`${field}.password`, "expected a non-empty string without line breaks");
    }
    password = obj.password;
  }
  if (!passwordEnv && !password) {
    throw new ConfigValidationError(
      `${field}.passwordEnv`,
      auth === "xoauth2"
        ? "set passwordEnv (the variable holding the access token) or password"
        : "set passwordEnv (the variable holding the app password) or password",
    );
  }
  const mailbox = obj.mailbox === undefined ? "INBOX" : plainString(obj.mailbox, `${field}.mailbox`, "a folder name");
  // Non-ASCII folder names need modified UTF-7, which is not done here.
  if (!/^[\x20-\x7e]+$/.test(mailbox)) {
    throw new ConfigValidationError(`${field}.mailbox`, "expected an ASCII folder name");
  }
  let authservId: string | undefined;
  if (obj.authservId !== undefined && obj.authservId !== null) {
    authservId = plainString(obj.authservId, `${field}.authservId`, "an authserv-id").toLowerCase();
  } else {
    authservId = KNOWN_AUTHSERV_IDS[host];
  }
  const rawAtt = obj.attachments ?? {};
  if (rawAtt === null || typeof rawAtt !== "object" || Array.isArray(rawAtt)) {
    throw new ConfigValidationError(`${field}.attachments`, "expected an object");
  }
  const att = rawAtt as Record<string, unknown>;
  const attachments: ImapAttachmentLimits = {
    save: optionalBool(att.save, IMAP_ATTACHMENT_DEFAULTS.save, `${field}.attachments.save`),
    maxCount: positiveInt(att.maxCount, IMAP_ATTACHMENT_DEFAULTS.maxCount, `${field}.attachments.maxCount`, 50),
    maxBytes: positiveInt(att.maxBytes, IMAP_ATTACHMENT_DEFAULTS.maxBytes, `${field}.attachments.maxBytes`, IMAP_ATTACHMENT_TOTAL_CEILING),
    maxTotalBytes: positiveInt(
      att.maxTotalBytes,
      IMAP_ATTACHMENT_DEFAULTS.maxTotalBytes,
      `${field}.attachments.maxTotalBytes`,
      IMAP_ATTACHMENT_TOTAL_CEILING,
    ),
  };
  return {
    host,
    port,
    user,
    auth,
    ...(passwordEnv ? { passwordEnv } : {}),
    ...(password ? { password } : {}),
    mailbox,
    idle: optionalBool(obj.idle, true, `${field}.idle`),
    markSeen: optionalBool(obj.markSeen, true, `${field}.markSeen`),
    ...(authservId ? { authservId } : {}),
    attachments,
  };
}

/** The secret for a binding, read when connecting so `.env` edits apply. */
export function resolveImapSecret(
  cfg: Pick<ImapTriggerConfig, "passwordEnv" | "password">,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnv = cfg.passwordEnv ? env[cfg.passwordEnv] : undefined;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return cfg.password ?? null;
}
