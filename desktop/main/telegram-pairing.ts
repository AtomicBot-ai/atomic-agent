/**
 * Telegram pairing from the app (ATO-859): the agent's
 * `/api/telegram/pairing` routes, read for the renderer.
 *
 * `POST` opens a 5-minute window and answers with the one-time code;
 * `GET` says where the window stands (`waiting`, `claimed` with the new
 * owner's "Paired: ..." line, `expired`, `cancelled`, `failed`, `idle`);
 * `DELETE` cancels it. An agent without the routes answers its
 * unknown-route 404, reported as `unsupported` so the Telegram tab can
 * say the agent needs an update instead of offering a button that fails.
 *
 * The code passes through here on its way to the screen and nowhere
 * else: nothing in this file logs, and neither does its IPC handler.
 */

export type TelegramPairingOp = "start" | "status" | "cancel";

export type TelegramPairingResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; code?: string; unsupported?: boolean };

export const TELEGRAM_PAIRING_PATH = "/api/telegram/pairing";

export function isTelegramPairingOp(v: unknown): v is TelegramPairingOp {
  return v === "start" || v === "status" || v === "cancel";
}

/** The method and body for `op`; `replaceOwner` only rides on a start. */
export function pairingRequest(
  op: TelegramPairingOp,
  replaceOwner: boolean,
): { method: "POST" | "GET" | "DELETE"; body?: { replaceOwner: boolean } } {
  if (op === "start") return { method: "POST", body: { replaceOwner } };
  return { method: op === "status" ? "GET" : "DELETE" };
}

/** The agent's answer, as the renderer reads it. */
export function readPairingReply(status: number, text: string): TelegramPairingResult {
  if (status === 404) {
    return { ok: false, unsupported: true, error: "this agent has no Telegram pairing route" };
  }
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const obj = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (status >= 200 && status < 300) {
    if (!obj) return { ok: false, error: `unreadable reply (HTTP ${status})` };
    return { ok: true, data: obj };
  }
  const err = obj && typeof obj["error"] === "object" && obj["error"] !== null ? (obj["error"] as Record<string, unknown>) : null;
  const message = err && typeof err["message"] === "string" && err["message"] ? err["message"] : `HTTP ${status}`;
  const code = err && typeof err["code"] === "string" ? err["code"] : undefined;
  return code ? { ok: false, error: message, code } : { ok: false, error: message };
}
