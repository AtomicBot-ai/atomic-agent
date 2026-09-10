import {
  sendOutbound,
  type OutboundSendResult,
  type TelegramApi,
  type TelegramLogger,
} from "./outbound-sender.js";

/**
 * One message to one chat from a process that runs no bot: the detached
 * download worker, a scheduler tick, anything that ends and wants to
 * say so. Talks to the Bot API over plain `fetch` — grammy's `Bot` is
 * only needed for `getUpdates`, and a second poller on the same token
 * is exactly what the channel lockfile exists to prevent. `sendMessage`
 * takes no lock: it is a request, not a subscription.
 *
 * Built on `sendOutbound`, so chunking, the single 429 retry and the
 * HTML→plain fallback behave as they do in the live channel.
 */
export interface OneShotTelegramInput {
  token: string;
  chatId: number;
  text: string;
  logger?: TelegramLogger;
  /** Test seam; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam; defaults to `https://api.telegram.org`. */
  apiBase?: string;
}

const DEFAULT_API_BASE = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 15_000;

/** A `TelegramApi` whose `sendMessage` is one HTTPS POST. */
export function fetchTelegramApi(opts: {
  token: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}): TelegramApi {
  const call = opts.fetchImpl ?? fetch;
  const base = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  return {
    async sendMessage(chatId, text, extra) {
      const res = await call(`${base}/bot${opts.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, ...(extra ?? {}) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        result?: unknown;
        error_code?: number;
        description?: string;
        parameters?: unknown;
      } | null;
      if (!res.ok || !body || body.ok !== true) {
        // Shaped like grammy's `GrammyError` so `sendOutbound`'s 429 and
        // parse-error sniffing applies unchanged.
        throw Object.assign(
          new Error(body?.description ?? `HTTP ${res.status}`),
          {
            error_code: body?.error_code ?? res.status,
            description: body?.description ?? `HTTP ${res.status}`,
            parameters: body?.parameters ?? {},
          },
        );
      }
      return body.result;
    },
  };
}

export async function sendTelegramOneShot(
  input: OneShotTelegramInput,
): Promise<OutboundSendResult> {
  const api = fetchTelegramApi(input);
  return sendOutbound({
    api,
    chatId: input.chatId,
    text: input.text,
    parseMode: "plain",
    ...(input.logger ? { logger: input.logger } : {}),
  });
}
