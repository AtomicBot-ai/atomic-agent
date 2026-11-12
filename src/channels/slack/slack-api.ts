/**
 * The Slack Web API methods this channel calls, over `fetch`:
 * `auth.test`, `apps.connections.open`, `chat.postMessage`,
 * `chat.update`, `chat.postEphemeral`.
 *
 * Slack answers HTTP 200 with `{ ok: false, error }` for most failures,
 * so every call checks `ok` and throws a `SlackApiError` carrying the
 * error code. HTTP 429 carries `Retry-After` in seconds; it is honoured
 * a couple of times and then surfaced, which is enough for a
 * single-operator remote control whose only burst is a chunked reply.
 */

import { chunkMessage } from "../discord/discord-channel-types.js";
import {
  SLACK_API_BASE,
  SLACK_MESSAGE_LIMIT,
  type SlackTarget,
} from "./slack-types.js";

export class SlackApiError extends Error {
  /** Slack's error code (`invalid_auth`, `channel_not_found`, …) or `http_<status>`. */
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? `Slack API error: ${code}`);
    this.name = "SlackApiError";
    this.code = code;
  }
}

export interface SlackApiOptions {
  botToken: string;
  appToken: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** How many 429s to wait out before giving up. */
  maxRateLimitRetries?: number;
  /** Test seam; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam for the 429 wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Longest `Retry-After` honoured; a longer one is surfaced, not slept. */
const MAX_RETRY_AFTER_MS = 30_000;

export class SlackApi {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly opts: SlackApiOptions) {
    this.base = opts.baseUrl ?? SLACK_API_BASE;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRateLimitRetries ?? 2;
  }

  /** The bot's own identity, for mention stripping and self-filtering. */
  async authTest(): Promise<{ userId: string; teamId: string | null }> {
    const body = await this.call("auth.test", this.opts.botToken);
    if (typeof body.user_id !== "string") {
      throw new SlackApiError("malformed_response", "Slack auth.test returned no user_id.");
    }
    return {
      userId: body.user_id,
      teamId: typeof body.team_id === "string" ? body.team_id : null,
    };
  }

  /** A fresh single-use Socket Mode URL (app-level token). */
  async openConnection(): Promise<string> {
    const body = await this.call("apps.connections.open", this.opts.appToken);
    if (typeof body.url !== "string" || body.url.length === 0) {
      throw new SlackApiError("malformed_response", "Slack returned no Socket Mode URL.");
    }
    return body.url;
  }

  /** Post one message; returns its `ts`. */
  async postMessage(
    target: SlackTarget,
    text: string,
    blocks?: readonly unknown[],
  ): Promise<string | null> {
    const body = await this.call("chat.postMessage", this.opts.botToken, {
      channel: target.channel,
      text,
      ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      ...(blocks ? { blocks } : {}),
      // Agent replies quote URLs constantly; unfurling every one turns
      // a short answer into a wall of previews.
      unfurl_links: false,
      unfurl_media: false,
    });
    return typeof body.ts === "string" ? body.ts : null;
  }

  /** Post `text` split into message-sized chunks, in order. */
  async postText(target: SlackTarget, text: string): Promise<void> {
    for (const chunk of chunkMessage(text, SLACK_MESSAGE_LIMIT)) {
      await this.postMessage(target, chunk);
    }
  }

  /** Replace a message's text and blocks (an answered approval). */
  async updateMessage(
    channel: string,
    ts: string,
    text: string,
    blocks: readonly unknown[] = [],
  ): Promise<void> {
    await this.call("chat.update", this.opts.botToken, { channel, ts, text, blocks });
  }

  /** A message only `user` sees (a refused approval click). */
  async postEphemeral(target: SlackTarget, user: string, text: string): Promise<void> {
    await this.call("chat.postEphemeral", this.opts.botToken, {
      channel: target.channel,
      user,
      text,
      ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
    });
  }

  private async call(
    method: string,
    token: string,
    args?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    for (let attempt = 0; ; attempt += 1) {
      const res = await doFetch(`${this.base}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": args
            ? "application/json; charset=utf-8"
            : "application/x-www-form-urlencoded",
        },
        ...(args ? { body: JSON.stringify(args) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 429) {
        const waitMs = retryAfterMs(res.headers.get("retry-after"));
        if (attempt >= this.maxRetries || waitMs > MAX_RETRY_AFTER_MS) {
          throw new SlackApiError("ratelimited", `Slack rate-limited ${method}.`);
        }
        await (this.opts.sleep ?? defaultSleep)(waitMs);
        continue;
      }
      if (!res.ok) {
        throw new SlackApiError(`http_${res.status}`, `Slack ${method} returned HTTP ${res.status}.`);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new SlackApiError("malformed_response", `Slack ${method} returned no JSON.`);
      }
      const obj = (body ?? {}) as Record<string, unknown>;
      if (obj.ok !== true) {
        const code = typeof obj.error === "string" ? obj.error : "unknown_error";
        throw new SlackApiError(code, `Slack ${method} failed: ${code}`);
      }
      return obj;
    }
  }
}

/** `Retry-After` is whole seconds; a missing or odd value waits one second. */
export function retryAfterMs(header: string | null): number {
  if (header === null || header.trim() === "") return 1000;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 1000;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
