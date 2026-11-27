/**
 * Settings › Connections › Telegram: the one request that checks a bot token
 * before it is saved (ATO-426, U-77).
 *
 * The renderer cannot ask Telegram itself (its CSP has `connect-src 'none'`),
 * so main makes the call the agent makes at start
 * (src/channels/telegram/telegram-channel.ts `bot.api.getMe()`): one GET to
 * `https://api.telegram.org/bot<token>/getMe`. Telegram answers 401 for a
 * token it does not know and 404 for one that is not even shaped like a
 * token; both are `rejected`, and the window does not save such a token.
 * Anything else that is not a 200 (offline, a 5xx, a timeout) is a token
 * that could not be checked: the window saves it with a warning, as the
 * Composio pane does (composio-key.ts), since the agent itself starts
 * without the channel when the token is bad.
 *
 * The token goes into the request URL and nowhere else: no log line, no
 * analytics property, no error message and no answer carries it. The shape
 * is checked here again (the value crosses IPC and becomes a URL path
 * segment), so a `/`, `?` or `#` can never redirect the request.
 */

export const TELEGRAM_API_BASE = "https://api.telegram.org";
const CHECK_TIMEOUT_MS = 15_000;

/* renderer/telegram-token.js TG_TOKEN_RE, verbatim. */
const TELEGRAM_TOKEN_RE = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/;
export const TELEGRAM_TOKEN_INVALID = "That does not look like a Telegram bot token.";

/** Why a token cannot be checked or written as given, or null. Never quotes the value back. */
export function telegramTokenValueError(value: unknown): string | null {
  return typeof value === "string" && TELEGRAM_TOKEN_RE.test(value) ? null : TELEGRAM_TOKEN_INVALID;
}

export type TelegramTokenCheck =
  | { ok: true; username: string | null; botId: number | null }
  /** `rejected`: Telegram refused the token itself (401/404). Otherwise it could not be checked. */
  | { ok: false; rejected: boolean; status: number; error: string };

export interface CheckTelegramTokenOptions {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** getMe as a verdict instead of a throw. */
export async function checkTelegramToken(opts: CheckTelegramTokenOptions): Promise<TelegramTokenCheck> {
  const shape = telegramTokenValueError(opts.token);
  if (shape) return { ok: false, rejected: true, status: 0, error: shape };
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${opts.baseUrl ?? TELEGRAM_API_BASE}/bot${opts.token}/getMe`, {
      method: "GET",
      signal: AbortSignal.timeout(opts.timeoutMs ?? CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, rejected: false, status: 0, error: `Could not reach Telegram: ${reachError(err)}` };
  }
  if (res.status === 401 || res.status === 404) {
    return { ok: false, rejected: true, status: res.status, error: `Telegram did not accept the token (HTTP ${res.status}).` };
  }
  if (!res.ok) {
    return { ok: false, rejected: false, status: res.status, error: `Telegram returned HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, rejected: false, status: res.status, error: "Telegram returned a reply that is not JSON." };
  }
  // The Bot API wraps every answer: {ok: true, result: {id, username, ...}}; {ok: false, description} on an error.
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (obj.ok !== true) {
    const why = typeof obj.description === "string" && obj.description ? obj.description : "no reason given";
    return { ok: false, rejected: false, status: res.status, error: `Telegram did not confirm the bot: ${why}.` };
  }
  const me = obj.result && typeof obj.result === "object" ? (obj.result as Record<string, unknown>) : {};
  return {
    ok: true,
    username: typeof me.username === "string" && me.username ? me.username : null,
    botId: typeof me.id === "number" ? me.id : null,
  };
}

/* A network failure in words, without the request: a timeout says so,
   anything else is the error's own message (fetch's are about the host and
   the socket, never the URL). */
function reachError(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "the request timed out.";
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : null;
  const msg = cause || (err instanceof Error ? err.message : String(err));
  return msg.endsWith(".") ? msg : `${msg}.`;
}
