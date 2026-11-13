/**
 * Shared primitives for the Matrix remote-control channel (ATO-632).
 *
 * atomic-agent talks to a Matrix homeserver over the plain
 * Client-Server API with the global `fetch`: no `matrix-js-sdk`, no
 * `matrix-bot-sdk`. The channel needs a handful of endpoints (whoami,
 * sync, join, leave, send, typing); a client library would add a large
 * dependency tree to a single-file SEA binary for code we would still
 * wrap. Same reasoning as the Discord adapter.
 *
 * Unencrypted rooms only. End-to-end encryption needs the native
 * `@matrix-org/matrix-sdk-crypto-nodejs` module, which has to be proven
 * in the SEA build and on Windows first; until then an encrypted room
 * gets one plain-text notice saying so (see `ENCRYPTED_ROOM_NOTICE`).
 */

import type { ExtraChannelConfig } from "../../config/extra-channel-config.js";

/** Env var holding the bot account's access token. Never in `config.json`. */
export const MATRIX_ACCESS_TOKEN_KEY = "MATRIX_ACCESS_TOKEN";

/**
 * Longest body one outbound event carries. The spec caps a whole event
 * at 65 536 bytes, and `formatted_body` roughly doubles the text, so
 * 8000 characters leaves room for HTML and multi-byte scripts.
 */
export const MATRIX_MESSAGE_LIMIT = 8000;

/** Server-side long-poll window for `/sync`. */
export const MATRIX_SYNC_TIMEOUT_MS = 30_000;

/** Sent at most once per room per window when an encrypted event arrives. */
export const ENCRYPTED_ROOM_NOTICE =
  "This room is end-to-end encrypted, and atomic-agent cannot read encrypted messages yet. " +
  "Talk to me in an unencrypted room (create a room with encryption off and invite me).";

/** One encrypted-room notice per room per this many ms. */
export const ENCRYPTED_NOTICE_INTERVAL_MS = 10 * 60_000;

/** The adapter's own `channels.matrix.options`, validated. */
export interface MatrixOptions {
  /** `https://matrix.example.org`, no trailing slash; `null` = not configured. */
  homeserver: string | null;
  /** The bot's mxid when the operator set it; else read from `/account/whoami`. */
  userId: string | null;
}

/**
 * Read `options.homeserver` and `options.userId`. A homeserver that is
 * not an http(s) URL reads as missing, so the channel stays `disabled`
 * rather than sending the token to something that is not a server.
 * Plain `http:` is accepted only for a loopback host (a local Synapse
 * or Conduit while testing): anywhere else the token would cross the
 * network in clear text.
 */
export function readMatrixOptions(config: ExtraChannelConfig): MatrixOptions {
  const rawServer = config.options.homeserver;
  const rawUser = config.options.userId;
  return {
    homeserver: typeof rawServer === "string" ? normalizeHomeserver(rawServer) : null,
    userId:
      typeof rawUser === "string" && isMatrixUserId(rawUser.trim()) ? rawUser.trim() : null,
  };
}

export function normalizeHomeserver(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** `@localpart:server` — the shape of a Matrix user id. */
export function isMatrixUserId(value: string): boolean {
  return /^@[^\s:]+:[^\s]+$/.test(value);
}

/**
 * Resolve the access token. Explicit `token` wins (the test seam);
 * otherwise the env, with a blank value read as "not configured".
 */
export function resolveMatrixToken(
  explicit?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (explicit !== undefined) return explicit;
  const raw = env[MATRIX_ACCESS_TOKEN_KEY];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Replace anything token-shaped with `<token>`. Synapse tokens look
 * like `syt_<base64>_<rand>_<crc>`, other servers use opaque strings;
 * a query `access_token=` or an `Authorization: Bearer` echo can reach
 * an error message, and those strings reach `lastError`, the TUI and
 * the logs.
 */
export function scrubMatrixError(err: unknown, token?: string | null): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (token && token.length >= 8) msg = msg.split(token).join("<token>");
  return msg
    .replace(/\bsy[a-z]_[A-Za-z0-9_-]{10,}/g, "<token>")
    .replace(/(access_token=)[^&\s"']+/gi, "$1<token>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<token>");
}
