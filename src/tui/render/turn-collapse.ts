import type { ChatMessage, ToolCardEntry } from "../tui-state.js";

/**
 * A finished turn folds into one line (ATO-963), the terminal port of the
 * desktop's `turn-summary.js` (ATO-464).
 *
 * While a turn runs its steps are drawn live, exactly as before. Once the
 * reply that closes it has landed, its tool cards and its reasoning bubble
 * fold into one quiet line, `Used 6 tools · 1 failed · 40s ▸`, that opens in
 * place on a click or with `/expand`. `tui.showSteps` (`/steps on`) keeps
 * every finished turn open, as it used to be; off by default.
 *
 * What folds: the visible tool cards (`reply` is never drawn) and the
 * reasoning blocks an assistant message carries. The reply text, its
 * buttons and every user / system message stay on screen. A message with no
 * visible tool card is left alone: folding a lone reasoning bubble trades one
 * line for another. While a turn is running, nothing after the message that
 * opened it folds, so an interim progress note keeps its cards in sight.
 *
 * Pure: no React, no I/O. `ChatLog`, `FinalisedMessage` and
 * `estimateMessageHeight` all ask this module, so a fold is either drawn and
 * counted or neither.
 */

/** Cards the chat never draws; they do not count as steps either. */
const HIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set(["reply"]);

export interface TurnFold {
  /** The assistant message whose steps fold. */
  messageId: string;
  /** Visible tool cards in the fold. */
  tools: number;
  /** Cards that came back with an error. */
  failed: number;
  /** Cards with no result: a stopped or cut-off turn. */
  unfinished: number;
  /** Reasoning blocks folded along with the cards. */
  reasons: number;
  /**
   * How long this part of the turn worked: from the message that started it
   * (the opening prompt or the previous reply) to this reply. `null` when
   * there is no such message on screen, so the line prints no time rather
   * than a made-up one.
   */
  durationMs: number | null;
  /** The folded cards, for a caller that wants to describe them. */
  cards: readonly ToolCardEntry[];
}

export interface TurnFoldOptions {
  /** `tui.showSteps`: every finished turn stays open, nothing folds. */
  always?: boolean;
  /** A turn is in flight: its messages so far do not fold yet. */
  running?: boolean;
}

/** Cards of `message` the chat actually draws. */
export function visibleTurnCards(
  message: Pick<ChatMessage, "toolCards">,
): readonly ToolCardEntry[] {
  return (message.toolCards ?? []).filter(
    (card) => !HIDDEN_TOOL_NAMES.has(card.tool),
  );
}

/**
 * The folds of `messages`, keyed by the assistant message id. A message
 * missing from the map is drawn as it always was.
 */
export function turnFoldsOf(
  messages: readonly ChatMessage[],
  opts: TurnFoldOptions = {},
): Map<string, TurnFold> {
  const out = new Map<string, TurnFold>();
  if (opts.always) return out;
  // The running turn starts at the last message that opened a turn (a
  // steer does not open one). Everything after it is still live.
  let liveFrom = messages.length;
  if (opts.running) {
    // No opener on screen (a re-attached running thread): all of it is live.
    liveFrom = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isTurnOpener(messages[i])) {
        liveFrom = i;
        break;
      }
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    if (i > liveFrom) continue;
    const cards = visibleTurnCards(message);
    if (cards.length === 0) continue;
    out.set(message.id, {
      messageId: message.id,
      tools: cards.length,
      failed: cards.filter((c) => c.status === "error").length,
      unfinished: cards.filter((c) => c.status === "pending").length,
      reasons: message.reasoningBlocks?.length ?? 0,
      durationMs: segmentDuration(messages, i),
      cards,
    });
  }
  return out;
}

function isTurnOpener(message: ChatMessage | undefined): boolean {
  return message !== undefined && message.role === "user" && message.steered !== true;
}

/**
 * From the message this reply answers (the prompt that opened the turn, or
 * the previous reply of the same turn) to this reply. System notices and
 * steers sit inside a turn and do not start one, so they are skipped.
 */
function segmentDuration(
  messages: readonly ChatMessage[],
  index: number,
): number | null {
  const end = messages[index]?.timestamp;
  if (end === undefined || !Number.isFinite(end)) return null;
  for (let i = index - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "assistant" || isTurnOpener(m)) {
      const ms = end - m.timestamp;
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    }
  }
  return null;
}

/**
 * Turns the folded cards into the line's words, e.g. "Read 3 files, ran 2
 * commands". Optional: return `null` or an empty string to keep the default
 * "Used N tools". A seam for the shared step verbs (ATO-962), so this module
 * does not depend on them.
 */
export type DescribeFoldedCards = (
  cards: readonly ToolCardEntry[],
) => string | null;

/** The line's words: "Used 1 tool", "Used 6 tools". */
export function turnFoldLabel(
  fold: TurnFold,
  describe?: DescribeFoldedCards,
): string {
  const described = describe?.(fold.cards);
  if (typeof described === "string" && described.trim().length > 0) {
    return described.trim();
  }
  return `Used ${fold.tools} tool${fold.tools === 1 ? "" : "s"}`;
}

/** `40s`, `1m 07s`; `<1s` under a second; `null` for no time at all. */
export function formatTurnFoldDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return "<1s";
  // Same `12s` / `1m 07s` form as the live elapsed counter
  // (`hooks/use-elapsed.ts`), kept here so the reducer does not pull in
  // React through this module.
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
}

export const TURN_FOLD_CLOSED_GLYPH = "▸";
export const TURN_FOLD_OPEN_GLYPH = "▾";

/** The pieces of the summary line, so the renderer can colour each one. */
export interface TurnFoldLineParts {
  label: string;
  /** `1 failed`, or `null` when nothing failed. */
  failed: string | null;
  /** `2 unfinished`, or `null`. */
  unfinished: string | null;
  /** `40s`, or `null` when the time is unknown. */
  duration: string | null;
  /** `▸` closed, `▾` open. */
  chevron: string;
}

export function turnFoldLineParts(
  fold: TurnFold,
  opts: { open: boolean; describe?: DescribeFoldedCards },
): TurnFoldLineParts {
  return {
    label: turnFoldLabel(fold, opts.describe),
    failed: fold.failed > 0 ? `${fold.failed} failed` : null,
    unfinished: fold.unfinished > 0 ? `${fold.unfinished} unfinished` : null,
    duration: formatTurnFoldDuration(fold.durationMs),
    chevron: opts.open ? TURN_FOLD_OPEN_GLYPH : TURN_FOLD_CLOSED_GLYPH,
  };
}

/** The whole line as plain text: `Used 6 tools · 1 failed · 40s ▸`. */
export function turnFoldLineText(
  fold: TurnFold,
  opts: { open: boolean; describe?: DescribeFoldedCards },
): string {
  const p = turnFoldLineParts(fold, opts);
  const head = [p.label, p.failed, p.unfinished, p.duration]
    .filter((s): s is string => s !== null)
    .join(" · ");
  return `${head} ${p.chevron}`;
}

/**
 * The id of the newest folded turn, the one bare `/expand` opens. `null`
 * when no turn on screen is folded.
 */
export function lastTurnFoldId(
  messages: readonly ChatMessage[],
  opts: TurnFoldOptions = {},
): string | null {
  const folds = turnFoldsOf(messages, opts);
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = messages[i]?.id;
    if (id !== undefined && folds.has(id)) return id;
  }
  return null;
}
