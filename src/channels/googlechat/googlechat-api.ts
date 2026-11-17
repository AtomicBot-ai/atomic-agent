/**
 * The Pub/Sub and Google Chat REST calls this channel makes, over `fetch`.
 *
 * - `pull` / `acknowledge` on the operator's subscription (inbound).
 * - `spaces.messages.create` as the Chat app (outbound), replying in
 *   the thread when one is given.
 *
 * Retries: a 429 or 5xx on a send is retried a few times, waiting
 * `Retry-After` when the server gives one, else the shared full-jitter
 * schedule, capped so a misbehaving server cannot park a reply forever.
 * `pull` is not retried here: the loop owns that backoff. A 401 drops
 * the cached token and tries once more with a fresh one.
 */

import { backoffMs } from "../reconnect-backoff.js";
import { GoogleAuthError } from "./googlechat-auth.js";
import {
  CHAT_API,
  PUBSUB_API,
  isSpaceName,
  isThreadName,
  scrubGoogleChatError,
} from "./googlechat-types.js";

export interface PubsubReceivedMessage {
  ackId: string;
  message?: {
    data?: string;
    messageId?: string;
    attributes?: Record<string, string>;
  };
}

export class GoogleChatApiError extends Error {
  /** Retrying cannot help: bad request, no permission, no such resource. */
  readonly fatal: boolean;
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GoogleChatApiError";
    this.fatal = status === 400 || status === 401 || status === 403 || status === 404;
  }
}

export interface GoogleChatApiDeps {
  tokens: { token(): Promise<string>; invalidate(): void };
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

const MAX_SEND_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 30_000;

export class GoogleChatApi {
  constructor(private readonly deps: GoogleChatApiDeps) {}

  /** One `:pull`. Resolves `[]` when nothing arrived before the server's own timeout. */
  async pull(
    subscription: string,
    maxMessages: number,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<PubsubReceivedMessage[]> {
    let body: Record<string, unknown> | undefined;
    try {
      body = await this.request(
        `${PUBSUB_API}/${subscription}:pull`,
        { maxMessages },
        { retries: 0, signal, timeoutMs },
      );
    } catch (err) {
      // Our own client-side cap fired on an idle subscription: not a failure.
      if (err instanceof GoogleChatApiError && err.status === 408) return [];
      throw err;
    }
    const received = body?.receivedMessages;
    if (!Array.isArray(received)) return [];
    return received.filter(
      (m): m is PubsubReceivedMessage =>
        !!m && typeof m === "object" && typeof (m as { ackId?: unknown }).ackId === "string",
    );
  }

  async acknowledge(subscription: string, ackIds: readonly string[]): Promise<void> {
    if (ackIds.length === 0) return;
    await this.request(`${PUBSUB_API}/${subscription}:acknowledge`, { ackIds }, { retries: MAX_SEND_RETRIES });
  }

  /**
   * Post `text` into `space`. With `thread`, reply in that thread, or
   * start a new one if it is gone. Returns the new message's name.
   */
  async createMessage(space: string, text: string, thread?: string): Promise<string | undefined> {
    if (!isSpaceName(space)) throw new GoogleChatApiError("Refusing to post to a malformed space name.", 400);
    const inThread = thread !== undefined && isThreadName(thread) && thread.startsWith(`${space}/`);
    const url = inThread
      ? `${CHAT_API}/${space}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`
      : `${CHAT_API}/${space}/messages`;
    const body = await this.request(
      url,
      { text, ...(inThread ? { thread: { name: thread } } : {}) },
      { retries: MAX_SEND_RETRIES },
    );
    return typeof body?.name === "string" ? body.name : undefined;
  }

  private async request(
    url: string,
    body: unknown,
    opts: { retries: number; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Record<string, unknown> | undefined> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let token: string;
      try {
        token = await this.deps.tokens.token();
      } catch (err) {
        if (err instanceof GoogleAuthError) throw new GoogleChatApiError(err.message, err.fatal ? 401 : 503);
        throw new GoogleChatApiError(scrubGoogleChatError(err), 503);
      }
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.deps.timeoutMs ?? 30_000);
      const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
      let res: Response;
      try {
        res = await (this.deps.fetchImpl ?? fetch)(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (timeout.aborted && opts.retries === 0) {
          throw new GoogleChatApiError("Google request timed out.", 408);
        }
        if (attempt < opts.retries) {
          await this.wait(backoffMs(attempt + 1));
          continue;
        }
        throw new GoogleChatApiError(scrubGoogleChatError(err, [token]), 0);
      }
      const parsed = await readJson(res);
      if (res.ok) return parsed;
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.deps.tokens.invalidate();
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < opts.retries) {
        await this.wait(retryAfterMs(res) ?? backoffMs(attempt + 1));
        continue;
      }
      const err = parsed?.error as { status?: unknown; message?: unknown } | undefined;
      const status = typeof err?.status === "string" ? ` ${err.status}` : "";
      const detail = typeof err?.message === "string" ? `: ${err.message}` : "";
      const where = new URL(url).pathname.split(":").pop()?.split("/").pop() ?? "request";
      throw new GoogleChatApiError(
        scrubGoogleChatError(`Google ${where} failed with HTTP ${res.status}${status}${detail}`, [token]),
        res.status,
      );
    }
  }

  private wait(ms: number): Promise<void> {
    const capped = Math.min(ms, MAX_RETRY_WAIT_MS);
    if (this.deps.sleep) return this.deps.sleep(capped);
    return new Promise((resolve) => {
      setTimeout(resolve, capped).unref();
    });
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

/** `Retry-After` in seconds, when present and sane. */
export function retryAfterMs(res: Pick<Response, "headers">): number | undefined {
  const raw = res.headers.get("retry-after");
  if (raw === null || raw.trim() === "") return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_WAIT_MS) : undefined;
}
