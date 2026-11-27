/**
 * Bare words that act as commands when the bot is @mentioned
 * (ATO-2248): "@bot stop" cancels the channel's turn, "@bot status"
 * shows its session. In a busy guild channel typing the slash form
 * after a mention is easy to forget, and "stop" sent as a request would
 * otherwise queue a whole new turn behind the one it meant to end.
 *
 * Only an exact single word maps (case and a trailing "!" or "." are
 * ignored), so "@bot stop the server" is still a normal request.
 */

const MENTION_WORDS: Readonly<Record<string, string>> = {
  stop: "/cancel",
  cancel: "/cancel",
  status: "/status",
};

/** The slash command a mention-only word stands for, or `null`. */
export function mentionWordCommand(text: string): string | null {
  const word = text.trim().toLowerCase().replace(/[.!]+$/, "");
  return Object.hasOwn(MENTION_WORDS, word) ? MENTION_WORDS[word]! : null;
}
