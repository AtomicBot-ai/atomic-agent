import { randomBytes } from "node:crypto";

import type { PushNotifyConfig } from "../config/index.js";
import { knownSecretsFromEnv, maskSecrets } from "../error-reporting/index.js";

/**
 * Phone push through ntfy (https://ntfy.sh, or a server the operator
 * runs): one JSON POST to the server root naming the topic, and the
 * ntfy app subscribed to that topic rings (ATO-1129). No bot, no
 * account, no SDK — global `fetch`.
 *
 * One attempt with a hard timeout and no retries: a ping that cannot be
 * delivered in a few seconds is reported as `failed` and dropped, so a
 * dead server never piles requests up behind a run of finished turns.
 * Never throws.
 *
 * Every title and body goes through `maskSecrets` (with the agent's own
 * `.env` values as known secrets) before it is clipped: a phone lock
 * screen, and on the public server anyone holding the topic, is not a
 * place for a key the model happened to echo.
 */
export type PushSendResult =
  | { outcome: "sent" }
  | { outcome: "not_configured"; reason: string }
  | { outcome: "failed"; reason: string };

export interface PushMessage {
  title: string;
  body: string;
  /** ntfy emoji shortcodes, e.g. `white_check_mark`. */
  tags?: readonly string[];
  /** ntfy priority 1 (min, silent) … 5 (max). Default 3. */
  priority?: 1 | 2 | 3 | 4 | 5;
}

export interface PushSendInput {
  push: PushNotifyConfig;
  message: PushMessage;
  /** Defaults to `process.env` — where `loadConfig` puts `<stateDir>/.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /** Default {@link PUSH_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export const PUSH_TIMEOUT_MS = 8_000;
/** The body is clipped here: a glance on a lock screen, not the transcript. */
export const PUSH_BODY_MAX = 200;
const PUSH_TITLE_MAX = 80;

/**
 * A fresh, unguessable topic: `atag-` plus 144 random bits in base64url
 * (whose alphabet is exactly ntfy's topic alphabet). On the public
 * server the topic name is the only thing between a stranger and the
 * operator's pings, so it is never a word the operator picked.
 */
export function generatePushTopic(): string {
  return `atag-${randomBytes(18).toString("base64url")}`;
}

/** True when a push could be sent right now (switched on, topic set). */
export function isPushReady(push: PushNotifyConfig | undefined): boolean {
  return push !== undefined && push.enabled && push.topic !== null;
}

/** Where the phone subscribes: `https://ntfy.sh/<topic>`. */
export function pushSubscribeUrl(push: PushNotifyConfig): string | null {
  return push.topic === null ? null : `${push.server}/${push.topic}`;
}

/** Control characters out, whitespace folded, clipped with an ellipsis. */
export function cleanPushText(text: string, max: number): string {
  const flat = Array.from(text)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 32 || code === 0x7f || (code >= 0x80 && code < 0xa0)
        ? " "
        : ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

function failureReason(err: unknown): string {
  // Deliberately not `err.message` verbatim: undici's messages can carry
  // the request URL, and the URL carries the topic.
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return "timed out";
    }
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    return typeof code === "string" ? `network error (${code})` : "network error";
  }
  return "network error";
}

export async function sendPush(input: PushSendInput): Promise<PushSendResult> {
  const { push } = input;
  if (!push.enabled) return { outcome: "not_configured", reason: "push is off" };
  if (push.topic === null) return { outcome: "not_configured", reason: "no topic" };
  const env = input.env ?? process.env;
  const token = (env[push.tokenEnv] ?? "").trim();
  const known = knownSecretsFromEnv(env);
  const payload = {
    topic: push.topic,
    title: cleanPushText(maskSecrets(input.message.title, known), PUSH_TITLE_MAX),
    message:
      cleanPushText(maskSecrets(input.message.body, known), PUSH_BODY_MAX) || "-",
    ...(input.message.tags && input.message.tags.length > 0
      ? { tags: [...input.message.tags] }
      : {}),
    priority: input.message.priority ?? 3,
  };
  const doFetch = input.fetchImpl ?? fetch;
  try {
    // JSON to the server root, not headers on `/<topic>`: a header value
    // must be Latin-1, and a title is often not.
    const res = await doFetch(`${push.server}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(input.timeoutMs ?? PUSH_TIMEOUT_MS),
    });
    if (res.ok) return { outcome: "sent" };
    const hint =
      res.status === 401 || res.status === 403
        ? ` — the topic needs an access token (${push.tokenEnv} in .env)`
        : res.status === 429
          ? " — rate limited by the server"
          : "";
    return { outcome: "failed", reason: `ntfy answered ${res.status}${hint}` };
  } catch (err) {
    return { outcome: "failed", reason: failureReason(err) };
  }
}
