/**
 * The Matrix Client-Server calls this channel makes, over `fetch`.
 *
 * Rate limits: a 429 (or any `M_LIMIT_EXCEEDED`) is retried after the
 * server's `retry_after_ms` (or `Retry-After`), a few times, capped so
 * a misbehaving server cannot park a reply for minutes. Enough for a
 * single-operator remote control whose only bursty path is chunking
 * one long reply.
 */

import { chunkMessage } from "../discord/discord-channel-types.js";
import {
  formatMatrixMessage,
  formatMatrixNotice,
  type MatrixMessageContent,
} from "./matrix-format.js";
import { MATRIX_MESSAGE_LIMIT, scrubMatrixError } from "./matrix-types.js";

export class MatrixApiError extends Error {
  readonly status: number;
  readonly errcode: string | null;
  constructor(message: string, status: number, errcode: string | null = null) {
    super(message);
    this.name = "MatrixApiError";
    this.status = status;
    this.errcode = errcode;
  }

  /** The token is dead: reconnecting will fail the same way forever. */
  get fatal(): boolean {
    return (
      this.status === 401 ||
      this.errcode === "M_UNKNOWN_TOKEN" ||
      this.errcode === "M_MISSING_TOKEN" ||
      this.errcode === "M_USER_DEACTIVATED"
    );
  }
}

export interface MatrixApiOptions {
  homeserver: string;
  token: string;
  timeoutMs?: number;
  /** Test seam; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam for the 429 wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** The subset of a `/sync` response the channel reads. */
export interface MatrixSyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, { timeline?: { events?: MatrixEvent[] } }>;
    invite?: Record<string, { invite_state?: { events?: MatrixEvent[] } }>;
  };
}

export interface MatrixEvent {
  type: string;
  sender?: string;
  event_id?: string;
  state_key?: string;
  origin_server_ts?: number;
  content?: Record<string, unknown>;
}

const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 30_000;
const CS = "/_matrix/client/v3";

/**
 * Only the timeline events the channel acts on, no presence, no
 * account data, members lazy-loaded: a bot in a busy room must not
 * download the whole member list on every poll.
 */
export const MATRIX_SYNC_FILTER = JSON.stringify({
  presence: { not_types: ["*"] },
  account_data: { not_types: ["*"] },
  room: {
    timeline: { types: ["m.room.message", "m.room.encrypted"], limit: 50 },
    state: { lazy_load_members: true },
    ephemeral: { not_types: ["*"] },
    account_data: { not_types: ["*"] },
  },
});

export class MatrixApi {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private txnCounter = 0;
  private readonly txnPrefix = `atomic-${Date.now().toString(36)}`;

  constructor(private readonly opts: MatrixApiOptions) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep =
      opts.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
  }

  /** The account the token belongs to. */
  async whoami(): Promise<string> {
    const body = await this.request("GET", "/account/whoami");
    const userId = body?.user_id;
    if (typeof userId !== "string") {
      throw new MatrixApiError("Matrix returned no user id for the token.", 0);
    }
    return userId;
  }

  /** One long poll. `since: null` is the initial sync. */
  async sync(
    since: string | null,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<MatrixSyncResponse> {
    const params = new URLSearchParams({
      timeout: String(timeoutMs),
      filter: MATRIX_SYNC_FILTER,
    });
    if (since !== null) params.set("since", since);
    const body = await this.request("GET", `/sync?${params.toString()}`, undefined, {
      // The server holds the request for `timeoutMs`; give it slack.
      timeoutMs: timeoutMs + 15_000,
      ...(signal ? { signal } : {}),
    });
    if (typeof body?.next_batch !== "string") {
      throw new MatrixApiError("Matrix sync returned no next_batch.", 0);
    }
    return body as unknown as MatrixSyncResponse;
  }

  async joinRoom(roomId: string): Promise<void> {
    await this.request("POST", `/join/${encodeURIComponent(roomId)}`, {});
  }

  /** Leave (or reject an invite to) a room. */
  async leaveRoom(roomId: string): Promise<void> {
    await this.request("POST", `/rooms/${encodeURIComponent(roomId)}/leave`, {});
  }

  /** Send a reply, split at `MATRIX_MESSAGE_LIMIT`, with HTML where useful. */
  async sendMessage(roomId: string, text: string): Promise<string | null> {
    return this.sendChunks(roomId, text, formatMatrixMessage);
  }

  /** Send an automated notice (help, status, prompts), plain text. */
  async sendNotice(roomId: string, text: string): Promise<string | null> {
    return this.sendChunks(roomId, text, formatMatrixNotice);
  }

  async setTyping(roomId: string, userId: string, typing: boolean): Promise<void> {
    await this.request(
      "PUT",
      `/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`,
      typing ? { typing: true, timeout: 30_000 } : { typing: false },
    );
  }

  private async sendChunks(
    roomId: string,
    text: string,
    format: (chunk: string) => MatrixMessageContent,
  ): Promise<string | null> {
    let lastId: string | null = null;
    for (const chunk of chunkMessage(text, MATRIX_MESSAGE_LIMIT)) {
      const txnId = `${this.txnPrefix}-${++this.txnCounter}`;
      const body = await this.request(
        "PUT",
        `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
        format(chunk),
      );
      if (typeof body?.event_id === "string") lastId = body.event_id;
    }
    return lastId;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    extra: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown> | undefined> {
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(extra.timeoutMs ?? this.timeoutMs);
      const signal = extra.signal ? AbortSignal.any([timeout, extra.signal]) : timeout;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.opts.homeserver}${CS}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.opts.token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal,
        });
      } catch (err) {
        throw new MatrixApiError(scrubMatrixError(err, this.opts.token), 0);
      }
      const parsed = await readJson(res);
      const errcode = typeof parsed?.errcode === "string" ? parsed.errcode : null;
      if (res.ok) return parsed;
      if (
        (res.status === 429 || errcode === "M_LIMIT_EXCEEDED") &&
        attempt < MAX_RATE_LIMIT_RETRIES
      ) {
        await this.sleep(retryAfterMs(parsed, res));
        continue;
      }
      const detail = typeof parsed?.error === "string" ? `: ${parsed.error}` : "";
      throw new MatrixApiError(
        scrubMatrixError(
          `Matrix ${method} ${path.split("?")[0]} failed with HTTP ${res.status}${errcode ? ` ${errcode}` : ""}${detail}`,
          this.opts.token,
        ),
        res.status,
        errcode,
      );
    }
  }
}

async function readJson(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await res.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** `retry_after_ms` from the body, else `Retry-After` seconds, capped. */
export function retryAfterMs(
  body: Record<string, unknown> | undefined,
  res: Pick<Response, "headers">,
): number {
  const fromBody = body?.retry_after_ms;
  if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody >= 0) {
    return Math.min(fromBody, MAX_RETRY_WAIT_MS);
  }
  const raw = res.headers.get("retry-after");
  const header = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
  if (Number.isFinite(header) && header >= 0) {
    return Math.min(header * 1000, MAX_RETRY_WAIT_MS);
  }
  return 1000;
}
