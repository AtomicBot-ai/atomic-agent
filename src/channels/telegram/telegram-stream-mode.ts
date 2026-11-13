import type { TelegramStreamReplies } from "../../config/channel-config.js";

export type { TelegramStreamReplies };

/** Environment override for `telegram.streamReplies` (ATO-634). */
export const TELEGRAM_STREAM_REPLIES_ENV = "ATOMIC_AGENT_TELEGRAM_STREAM_REPLIES";

/**
 * Streaming is on in the owner's DM by default. Groups and forum topics
 * never stream (decision 75): several people read a group, a message
 * that rewrites itself every second is noisy there, and a group's flood
 * limit (about 20 messages a minute) is much lower than a DM's. They get
 * the editable progress message and one final answer instead.
 */
export const DEFAULT_TELEGRAM_STREAM_REPLIES: TelegramStreamReplies = "private";

/**
 * The stream mode for this process: the environment variable when it
 * holds a known value, else the config value, else the default. The
 * variable also takes the usual switch words (`0`/`false`/`no` = off,
 * `1`/`true`/`yes`/`on` = the default `private`); anything else is
 * ignored rather than failing channel start.
 */
export function resolveTelegramStreamReplies(
  configured: TelegramStreamReplies | undefined,
  env: NodeJS.ProcessEnv = process.env,
): TelegramStreamReplies {
  const fromEnv = parseStreamWord(env[TELEGRAM_STREAM_REPLIES_ENV]);
  return fromEnv ?? configured ?? DEFAULT_TELEGRAM_STREAM_REPLIES;
}

/** Whether a turn in this chat streams its reply: DMs only. Absent mode = off. */
export function shouldStreamReplies(
  mode: TelegramStreamReplies | undefined,
  isPrivate: boolean,
): boolean {
  return mode === "private" && isPrivate;
}

function parseStreamWord(raw: string | undefined): TelegramStreamReplies | null {
  if (raw === undefined) return null;
  const word = raw.trim().toLowerCase();
  if (word === "off" || word === "private") return word;
  if (word === "0" || word === "false" || word === "no") return "off";
  if (word === "1" || word === "true" || word === "yes" || word === "on") {
    return DEFAULT_TELEGRAM_STREAM_REPLIES;
  }
  return null;
}
