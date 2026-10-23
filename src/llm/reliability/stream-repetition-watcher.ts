import {
  MAX_REPEAT_PERIOD_CHARS,
  MIN_SPAN_CHARS,
  repetitiveTailPeriod,
} from "./repetitive-tail.js";

/**
 * Watches a local model's reply while it streams and says when it has
 * fallen into a loop, so the request can be aborted instead of running
 * to the reply cap. Seen live: 16,384 tokens of one repeated code block
 * in 18 minutes on an 8 GB Mac, and a 27B model closing `}]"}]` over and
 * over in the middle of a chat reply.
 *
 * A loop (decided 23.10, ATO-331): the tail repeats one block exactly,
 * over at least `MIN_SPAN_CHARS` (256) characters AND at least
 * `STREAM_LOOP_MIN_REPEATS` (8) times in a row. So a short block like
 * `}]"}]` trips after 256 characters, a 64-character line after 8
 * copies (512 characters), and the longest block checked,
 * `MAX_REPEAT_PERIOD_CHARS` (512), after 8 copies (4 KB).
 *
 * Twice the repeats the after-the-fact check (`hasRepetitiveTail`)
 * wants, because a false positive here throws away a reply that might
 * have finished. Legit repetitive output is safe as long as its blocks
 * differ somewhere: table rows, CSV lines and similar functions carry
 * different values, names or numbers, and the match must be exact. What
 * still trips it is output that really is one block copied 8+ times (or
 * one character 256 times), e.g. a 9x9 grid of identical zero rows or a
 * long run of `=`. A local step gets one truncation retry, so when the
 * retry writes the same block again the step fails and the turn ends
 * with the repetition message.
 */

/** A block must repeat this many times in a row before the stream is cut. */
export const STREAM_LOOP_MIN_REPEATS = 8;

/** New characters between two checks, so a long reply is not rescanned per token. */
const CHECK_EVERY_CHARS = 32;

/**
 * The tail a check looks at: the longest run a loop needs, plus room
 * for trailing whitespace.
 */
const TAIL_WINDOW_CHARS =
  2 * Math.max(MAX_REPEAT_PERIOD_CHARS * STREAM_LOOP_MIN_REPEATS, MIN_SPAN_CHARS);

export interface StreamRepetition {
  /** Which channel looped. */
  channel: "content" | "reasoning";
  /** Length, in characters, of the repeated block. */
  periodChars: number;
}

export interface StreamRepetitionWatcher {
  /** Feed one streamed delta; returns the loop once the tail is one. */
  push(delta: string, reasoningDelta: string): StreamRepetition | null;
}

export function createStreamRepetitionWatcher(): StreamRepetitionWatcher {
  const channels = {
    content: { tail: "", sinceCheck: 0 },
    reasoning: { tail: "", sinceCheck: 0 },
  };
  const feed = (
    channel: "content" | "reasoning",
    text: string,
  ): StreamRepetition | null => {
    if (text.length === 0) return null;
    const state = channels[channel];
    state.tail = (state.tail + text).slice(-TAIL_WINDOW_CHARS);
    state.sinceCheck += text.length;
    if (state.sinceCheck < CHECK_EVERY_CHARS) return null;
    state.sinceCheck = 0;
    const period = repetitiveTailPeriod(state.tail, STREAM_LOOP_MIN_REPEATS);
    return period === null ? null : { channel, periodChars: period };
  };
  return {
    push(delta, reasoningDelta) {
      return feed("content", delta) ?? feed("reasoning", reasoningDelta);
    },
  };
}
