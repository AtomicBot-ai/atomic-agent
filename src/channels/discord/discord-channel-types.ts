/**
 * Shared primitives for the Discord remote-control channel.
 *
 * atomic-agent talks to Discord over the raw HTTP + Gateway APIs with
 * Node's built-in `fetch` and `WebSocket` — no `discord.js`, no
 * `@discordjs/*`. The channel needs six REST calls and one WebSocket
 * state machine; a client library would add a large transitive tree to
 * a project that ships a single-file SEA binary, for code we would
 * still have to wrap. Same reasoning as the Composio integration
 * declining `@composio/core` (see AGENTS.md §"Composio").
 */

/** Env var holding the bot token. Never stored in `config.json`. */
export const DISCORD_BOT_TOKEN_KEY = "DISCORD_BOT_TOKEN";

/** Pinned API version. Discord retires versions on a published schedule. */
export const DISCORD_API_VERSION = 10;

export const DISCORD_API_BASE = `https://discord.com/api/v${DISCORD_API_VERSION}`;

/**
 * Gateway intents the channel identifies with.
 *
 * `GUILD_MESSAGES | DIRECT_MESSAGES` deliberately excludes the
 * privileged `MESSAGE_CONTENT` (1 << 15). Discord sends full message
 * content without it in exactly the two cases this channel acts on —
 * a DM to the bot, and a message that @mentions the bot — so the
 * operator does not have to enable a privileged intent (or pass
 * Discord's verification once a bot is in 100+ guilds) to use the
 * feature. It also means the bot is structurally incapable of reading
 * guild chatter it was not addressed in, which is the right default
 * for something wired to a machine's shell.
 */
export const DISCORD_INTENTS = (1 << 9) | (1 << 12);

/** Gateway opcodes used by this client. */
export const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/**
 * Close codes Discord will never recover from by reconnecting. Retrying
 * these burns the session-start budget and, for 4004/4014, will fail
 * identically forever — so the channel stops and reports instead.
 */
export const FATAL_CLOSE_CODES = new Set([
  4004, // authentication failed — bad token
  4010, // invalid shard
  4011, // sharding required
  4012, // invalid API version
  4013, // invalid intents
  4014, // disallowed intents (privileged intent not enabled)
]);

/** Human-readable cause for the close codes an operator can act on. */
export function describeCloseCode(code: number): string {
  switch (code) {
    case 4004:
      return "Discord rejected the bot token.";
    case 4013:
      return "Discord rejected the gateway intents (invalid bitfield).";
    case 4014:
      return "Discord refused the requested intents — a privileged intent is not enabled for this bot.";
    default:
      return `Discord closed the gateway with code ${code}.`;
  }
}

/**
 * Replace anything bot-token-shaped with `<token>`.
 *
 * A Discord bot token is three base64url segments separated by dots.
 * Mirrors `scrubErrorMessage` in the Telegram channel: gateway and
 * fetch errors routinely embed the token in a URL or an
 * `Authorization` echo, and those strings reach `lastError`, the TUI,
 * and the logs.
 */
export function scrubDiscordError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(
    /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g,
    "<token>",
  );
}

/**
 * Resolve the bot token. Explicit `token` wins (the test seam);
 * otherwise read the env, treating blank as "not configured" so a
 * stray `DISCORD_BOT_TOKEN=` line does not read as a real token.
 */
export function resolveDiscordToken(
  explicit?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (explicit !== undefined) return explicit;
  const raw = env[DISCORD_BOT_TOKEN_KEY];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Discord rejects `content` longer than this on a normal message. */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Split `text` into message-sized chunks, preferring paragraph then
 * line boundaries so a long agent reply does not get cut mid-word.
 * A single line longer than the limit is hard-split — the alternative
 * is dropping it.
 */
export function chunkMessage(
  text: string,
  limit = DISCORD_MESSAGE_LIMIT,
): string[] {
  if (text.length <= limit) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Prefer the last paragraph break, then the last newline, then a
    // space; fall back to a hard cut only when the line has none.
    const cut =
      lastIndexBefore(window, "\n\n") ??
      lastIndexBefore(window, "\n") ??
      lastIndexBefore(window, " ") ??
      limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function lastIndexBefore(window: string, needle: string): number | undefined {
  const idx = window.lastIndexOf(needle);
  // Ignore a break so early that the chunk would be mostly empty --
  // that turns one long reply into a flood of tiny messages.
  return idx > window.length * 0.5 ? idx : undefined;
}
