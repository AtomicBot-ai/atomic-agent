/**
 * The six Discord REST calls this channel makes, over `fetch`.
 *
 * Rate limits are respected the cheap way: on a 429 we honour
 * `retry_after` once and retry. That is enough for a single-operator
 * remote control, where the only bursty path is chunking one long
 * reply; a full bucket-tracking client would be a lot of machinery for
 * traffic that is almost never concurrent.
 */

import {
  DISCORD_API_BASE,
  chunkMessage,
  scrubDiscordError,
} from "./discord-channel-types.js";

export interface DiscordUser {
  id: string;
  username: string;
  discriminator?: string;
}

export class DiscordApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DiscordApiError";
    this.status = status;
  }
}

/** One outbound message component row (approval buttons). */
export interface DiscordComponentRow {
  type: 1;
  components: ReadonlyArray<{
    type: 2;
    style: number;
    label: string;
    custom_id: string;
  }>;
}

export interface DiscordApiOptions {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class DiscordApi {
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: DiscordApiOptions) {
    this.base = opts.baseUrl ?? DISCORD_API_BASE;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** WebSocket URL to identify against. */
  async gatewayUrl(): Promise<string> {
    const body = (await this.request("GET", "/gateway/bot")) as {
      url?: unknown;
    };
    if (typeof body.url !== "string" || body.url.length === 0) {
      throw new DiscordApiError("Discord returned no gateway URL.", 0);
    }
    return body.url;
  }

  /** The bot's own identity — used to detect @mentions and self-messages. */
  async currentUser(): Promise<DiscordUser> {
    const body = (await this.request("GET", "/users/@me")) as
      | Record<string, unknown>
      | undefined;
    const id = body?.id;
    const username = body?.username;
    if (typeof id !== "string" || typeof username !== "string") {
      throw new DiscordApiError("Discord returned a malformed user.", 0);
    }
    return { id, username };
  }

  /**
   * Send `text` to a channel, split across as many messages as the
   * 2000-character limit needs. Returns the id of the last message.
   */
  async sendMessage(
    channelId: string,
    text: string,
    components?: readonly DiscordComponentRow[],
  ): Promise<string | null> {
    const chunks = chunkMessage(text);
    if (chunks.length === 0) return null;
    let lastId: string | null = null;
    for (const [i, chunk] of chunks.entries()) {
      const isLast = i === chunks.length - 1;
      const body = (await this.request(
        "POST",
        `/channels/${channelId}/messages`,
        {
          content: chunk,
          // Buttons belong on the final chunk, where the question is.
          ...(isLast && components ? { components } : {}),
        },
      )) as { id?: unknown } | undefined;
      if (typeof body?.id === "string") lastId = body.id;
    }
    return lastId;
  }

  /** Replace a message's content (used to settle an approval prompt). */
  async editMessage(
    channelId: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    await this.request("PATCH", `/channels/${channelId}/messages/${messageId}`, {
      content: text.slice(0, 2000),
      components: [],
    });
  }

  /**
   * Acknowledge a button press by editing the message it sits on
   * (interaction callback type 7 = UPDATE_MESSAGE). Discord requires a
   * response within 3 seconds or the user sees "interaction failed".
   */
  async updateInteraction(
    interactionId: string,
    interactionToken: string,
    text: string,
  ): Promise<void> {
    await this.request(
      "POST",
      `/interactions/${interactionId}/${interactionToken}/callback`,
      { type: 7, data: { content: text.slice(0, 2000), components: [] } },
    );
  }

  /** Open (or reuse) the DM channel with a user. */
  async createDmChannel(userId: string): Promise<string> {
    const body = (await this.request("POST", "/users/@me/channels", {
      recipient_id: userId,
    })) as { id?: unknown } | undefined;
    if (typeof body?.id !== "string") {
      throw new DiscordApiError("Discord returned no DM channel id.", 0);
    }
    return body.id;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    attempt = 0,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${this.opts.token}`,
          "Content-Type": "application/json",
          "User-Agent": "DiscordBot (https://atomicagent.io, 0.5.5)",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DiscordApiError(
        `Could not reach Discord: ${scrubDiscordError(err)}`,
        0,
      );
    }
    if (res.status === 429 && attempt === 0) {
      const retryAfter = await readRetryAfter(res);
      await sleep(Math.min(retryAfter * 1000, 10_000));
      return this.request(method, path, body, attempt + 1);
    }
    if (res.status === 401 || res.status === 403) {
      throw new DiscordApiError(
        `Discord rejected the bot token (HTTP ${res.status}).`,
        res.status,
      );
    }
    if (!res.ok) {
      throw new DiscordApiError(
        `Discord returned HTTP ${res.status} for ${method} ${path}.`,
        res.status,
      );
    }
    if (res.status === 204) return undefined;
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }
}

async function readRetryAfter(res: Response): Promise<number> {
  try {
    const body = (await res.json()) as { retry_after?: unknown };
    if (typeof body.retry_after === "number") return body.retry_after;
  } catch {
    // fall through to the header
  }
  const header = Number(res.headers.get("retry-after"));
  return Number.isFinite(header) ? header : 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
