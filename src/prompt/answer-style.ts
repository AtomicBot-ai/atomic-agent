/**
 * `### answer-style` — how the final `reply` should read (ATO-966).
 *
 * The block lives in the stable prefix, so it must be a pure function
 * of (channel, compact): the same session on the same channel and model
 * mode gets the same bytes on every step and every turn. A channel or
 * mode change (a fallback link with another mode, a session reopened
 * from another surface) costs one cold read, the same as a role change.
 *
 * Absent channel = no block at all, so every caller that does not pass
 * one (benchmarks, fusion workers, HTTP, scheduler, tests) keeps its
 * prefix byte-identical to before the block existed.
 *
 * `compact` is the short form for local models: same rules, a quarter of
 * the words, because every prefix byte is re-read on every step of a
 * small context window.
 */

/** Surfaces that show the reply to a person, each with its own limits. */
export type AnswerChannel = "terminal" | "desktop" | "telegram" | "discord";

/**
 * The surface a turn's reply is shown on, from where the turn came in.
 * `sidecar` is the desktop app's NDJSON channel. Origins with no person
 * reading the reply as chat (`fusion` workers answer the orchestrator,
 * `scheduler` / `http` / `cli` runs feed a report, an API client or a
 * benchmark) get no channel and therefore no block. Takes the
 * runtime's `TurnOrigin` as a plain string so `src/prompt` does not
 * import from `src/runtime`.
 */
export function answerChannelForOrigin(
  origin: string | undefined,
): AnswerChannel | undefined {
  switch (origin) {
    case "tui":
      return "terminal";
    case "sidecar":
      return "desktop";
    case "telegram":
      return "telegram";
    case "discord":
      return "discord";
    default:
      return undefined;
  }
}

/** Section header — pinned by tests. */
export const ANSWER_STYLE_HEADER = "### answer-style";

/**
 * Telegram caps one message at 4096 UTF-16 units and splits past it
 * (`outbound-sender.ts`); 3500 leaves room for the HTML the markdown
 * turns into.
 */
export const TELEGRAM_REPLY_MAX_CHARS = 3500;
/** Discord caps one message at 2000 (`DISCORD_MESSAGE_LIMIT`). */
export const DISCORD_REPLY_MAX_CHARS = 1800;
/** Replies longer than this many lines may use headings. */
export const HEADINGS_MIN_LINES = 20;

const FULL_RULES =
  `Lead with the answer or the result, then only the details that matter. ` +
  `Do not retell tool output or list the steps you took: say what it means (the number, the failing line, the files changed). ` +
  `Write file paths, commands and identifiers as \`code\`. ` +
  `Headings only when the reply runs past ~${HEADINGS_MIN_LINES} lines; otherwise short paragraphs or a short list. ` +
  `An exact format the request asks for overrides all of this.`;

const COMPACT_RULES =
  "Answer first, then key details. Do not repeat tool output. Paths as `code`. Headings only in long replies.";

const FULL_CHANNEL: Record<AnswerChannel, string> = {
  terminal:
    "Shown in a terminal: markdown renders, but keep tables to a few narrow columns and code blocks short.",
  desktop:
    "Shown in the desktop app: markdown renders in full (tables, code blocks, links).",
  telegram:
    `Shown in Telegram: no tables and no headings (they do not render); use short lists. ` +
    `Keep the reply under ${TELEGRAM_REPLY_MAX_CHARS} characters; put anything longer in a file and send it in \`attachments\`.`,
  discord:
    `Shown in Discord: no tables. Keep the reply under ${DISCORD_REPLY_MAX_CHARS} characters; put anything longer in a file and send it in \`attachments\`.`,
};

const COMPACT_CHANNEL: Record<AnswerChannel, string> = {
  terminal: "Terminal: no wide tables.",
  desktop: "Desktop app: markdown is fine.",
  telegram: `Telegram: no tables, under ${TELEGRAM_REPLY_MAX_CHARS} characters.`,
  discord: `Discord: no tables, under ${DISCORD_REPLY_MAX_CHARS} characters.`,
};

export interface AnswerStyleInput {
  channel: AnswerChannel;
  /** Short form for local / small models. */
  compact: boolean;
}

/** The block body (without the header). Deterministic per input. */
export function buildAnswerStyleGuidance(input: AnswerStyleInput): string {
  return input.compact
    ? `${COMPACT_RULES} ${COMPACT_CHANNEL[input.channel]}`
    : `${FULL_RULES}\n${FULL_CHANNEL[input.channel]}`;
}
