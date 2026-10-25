import {
  describeChannelLockConflict,
  isChannelLockConflict,
} from "../channels/channel-lock-error.js";

import { sendJson, type HttpHandler } from "./request-context.js";

/**
 * `GET /api/telegram/channel` — the Telegram channel's live state, and
 * whether it is held off by another poller of the same bot (ATO-758).
 *
 * A second agent on one bot token cannot start its channel: another
 * atomic-agent on this computer holds `telegram.lock` (a desktop agent left
 * running, the terminal agent), or Telegram itself answers 409 because the
 * bot is polled from somewhere else. The desktop's Telegram tab said
 * nothing of either; this is what it reads to say so.
 *
 * Answers `{ available, state, lastError, otherPoller }`: `otherPoller` is
 * `{ where: "this_computer", pid }` for the lock, `{ where: "elsewhere" }`
 * for Telegram's 409, `null` otherwise. `available: false` on an agent
 * without the channel. Bearer auth like every `/api` route.
 */
export function createTelegramChannelHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const channel = ctx.runtime.telegramChannel ?? null;
    if (!channel) {
      sendJson(res, 200, { available: false, state: null, lastError: null, otherPoller: null });
      return;
    }
    const lastError = channel.lastError();
    sendJson(res, 200, {
      available: true,
      state: channel.state(),
      lastError,
      otherPoller: otherPollerOf(lastError),
    });
  };
}

/** Who else polls the bot, read from the channel's last error. */
export function otherPollerOf(
  lastError: string | null,
): { where: "this_computer"; pid: number | null } | { where: "elsewhere" } | null {
  if (!lastError) return null;
  if (isChannelLockConflict(lastError)) {
    const pid = /\bpid (\d+)\b/.exec(describeChannelLockConflict(lastError))?.[1];
    return { where: "this_computer", pid: pid ? Number(pid) : null };
  }
  if (/\b409\b|terminated by other getUpdates|conflict/i.test(lastError)) return { where: "elsewhere" };
  return null;
}
