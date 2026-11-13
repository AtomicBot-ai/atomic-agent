/**
 * Shared primitives for the Google Chat remote-control channel (ATO-506).
 *
 * The operator registers their own Chat app in their own Google Cloud
 * project; we run no relay. The app is configured with a Cloud Pub/Sub
 * connection, and atomic-agent *pulls* events from a subscription, so
 * the machine needs no public URL. Everything goes over the global
 * `fetch` with a service-account token minted locally (see
 * `googlechat-auth.ts`): no `googleapis`, no `google-auth-library`.
 */

import type { ExtraChannelConfig } from "../../config/extra-channel-config.js";

/** Env var holding the *path* to the service-account JSON key file. */
export const GOOGLE_CHAT_CREDENTIALS_KEY = "GOOGLE_CHAT_CREDENTIALS";

/** Google Chat caps a text message at 4096 characters; leave a margin. */
export const GOOGLE_CHAT_MESSAGE_LIMIT = 4000;

/** Messages asked for per `:pull`. */
export const PULL_MAX_MESSAGES = 10;

/** Client-side cap on one `:pull`; the server returns earlier when it has nothing. */
export const PULL_TIMEOUT_MS = 90_000;

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const PUBSUB_API = "https://pubsub.googleapis.com/v1";
export const CHAT_API = "https://chat.googleapis.com/v1";

/** Both scopes ride on one token: pull from Pub/Sub, post as the Chat app. */
export const GOOGLE_CHAT_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/pubsub",
  "https://www.googleapis.com/auth/chat.bot",
];

/** The adapter's own `channels.googlechat.options`, validated. */
export interface GoogleChatOptions {
  /** `projects/<p>/subscriptions/<s>`; `null` = not configured. */
  subscription: string | null;
}

/**
 * Resource names go straight into request paths, so only the shapes
 * Google issues are accepted: no `/` inside a segment, no `?`, `#`, `..`.
 */
const SUBSCRIPTION_RE = /^projects\/[A-Za-z0-9.:_-]+\/subscriptions\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/;
const SPACE_RE = /^spaces\/[A-Za-z0-9_-]+$/;
const THREAD_RE = /^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_.-]+$/;

export function readGoogleChatOptions(config: ExtraChannelConfig): GoogleChatOptions {
  const raw = config.options.subscription;
  if (typeof raw !== "string") return { subscription: null };
  const trimmed = raw.trim();
  return { subscription: isSubscriptionName(trimmed) ? trimmed : null };
}

export function isSubscriptionName(value: string): boolean {
  return SUBSCRIPTION_RE.test(value) && !value.includes("..");
}

export function isSpaceName(value: unknown): value is string {
  return typeof value === "string" && SPACE_RE.test(value);
}

export function isThreadName(value: unknown): value is string {
  return typeof value === "string" && THREAD_RE.test(value) && !value.includes("..");
}

/**
 * Resolve the credentials file path. Explicit wins (the test seam);
 * otherwise the env, with a blank value read as "not configured".
 */
export function resolveCredentialsPath(
  explicit?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (explicit !== undefined) return explicit;
  const raw = env[GOOGLE_CHAT_CREDENTIALS_KEY];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Who a Chat event says sent it. */
export interface GoogleChatUserRef {
  name?: string | undefined;
  email?: string | undefined;
  type?: string | undefined;
}

/**
 * Owners are listed as `users/<id>` resource names or as emails. A
 * resource name matches exactly; an email case-insensitively. The
 * email only reaches an event when the Chat app is in the same
 * Workspace domain, so `users/<id>` is the reliable form.
 */
export function isGoogleChatOwner(
  ownerIds: readonly string[],
  user: GoogleChatUserRef | undefined,
): boolean {
  if (!user || ownerIds.length === 0) return false;
  const name = typeof user.name === "string" ? user.name : null;
  const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : null;
  return ownerIds.some((id) => {
    if (name !== null && id === name) return true;
    return email !== null && email.length > 0 && id.includes("@") && id.toLowerCase() === email;
  });
}

/**
 * Replace anything secret-shaped with `<redacted>`: OAuth access tokens
 * (`ya29.…`), signed JWT assertions, `Bearer` echoes, PEM private key
 * blocks and form-encoded `assertion=`. Those strings reach `lastError`,
 * the TUI and the logs.
 */
export function scrubGoogleChatError(err: unknown, secrets: readonly string[] = []): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) {
    if (secret.length >= 8) msg = msg.split(secret).join("<redacted>");
  }
  return msg
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "<redacted>")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "<redacted>")
    .replace(/(assertion=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>");
}
