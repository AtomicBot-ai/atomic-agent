/**
 * A completion whose visible text still holds a tagged tool call
 * (`<tool_call>…</tool_call>`, Qwen's `<function=NAME>` form) that no
 * parser turned into a call (GitHub #999, ATO-2428).
 *
 * The tagged-call adapter (`qwen-tagged-tool-response-adapter.ts`) turns
 * a reply made only of such blocks into native `tool_calls` when every
 * block names an offered tool with valid arguments. Whatever it declines
 * stays in `content`: an unknown or misspelled tool, broken JSON, an
 * unclosed tag at the end of the stream, or a block written after a line
 * of prose. Every transport then read that content as the answer, so the
 * raw XML reached the user (a Telegram chat in the report) and the tool
 * never ran.
 *
 * The step treats such a completion the way it treats an invented
 * `assistant_tool_call:` transcript (`fabricated-tool-transcript.ts`):
 * its `reply` / `finish` is not delivered, and the model is told on the
 * next step that the call did not run. Ollama and LM Studio make the same
 * call in their tool-call parsers: the tags never reach the visible text.
 *
 * What is NOT flagged, by the line rules the transcript detector uses:
 *  - a tag mentioned mid-line (`the <tool_call> tag wraps…`);
 *  - a block inside a CLOSED code fence, which is how an answer quotes
 *    the format. A fence still open at the end is not a quote.
 * One block is enough: unlike a transcript line, a line that opens with
 * the model's own tool-call markup is never prose.
 */

import type { FabricatedToolTranscript } from "./fabricated-tool-transcript.js";

/** A line that opens a tagged block. */
const TOOL_CALL_OPEN_LINE = /^\s*<tool_call>/;
/** Qwen's function header, written with or without the outer tag. */
const FUNCTION_OPEN_LINE = /^\s*<function=[^>\n]+>/;
const TOOL_CALL_CLOSE = "</tool_call>";
const FENCE_LINE = /^\s*(?:```|~~~)/;

/**
 * The number of tagged tool-call blocks in `text` that open at a line
 * start outside a closed code fence, or `null` when there are none.
 *
 * Callers pass the completion's visible text (reasoning removed): a
 * tagged call that sat in the reasoning channel was either recovered by
 * the adapter or is scratch space.
 */
export function countTaggedToolCallBlocks(text: string): number | null {
  if (!text.includes("<tool_call>") && !text.includes("<function=")) {
    return null;
  }
  let blocks = 0;
  let fencedBlocks = 0;
  let inFence = false;
  // Inside a `<tool_call>` block, so its own `<function=…>` line is not
  // counted as a second block.
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE_LINE.test(line)) {
      // A closed fence was a quote: drop what it held.
      if (inFence) fencedBlocks = 0;
      inFence = !inFence;
      inBlock = false;
      continue;
    }
    let opens = false;
    if (TOOL_CALL_OPEN_LINE.test(line)) {
      opens = true;
      inBlock = true;
    } else if (!inBlock && FUNCTION_OPEN_LINE.test(line)) {
      opens = true;
    }
    if (opens) {
      if (inFence) fencedBlocks += 1;
      else blocks += 1;
    }
    if (line.includes(TOOL_CALL_CLOSE)) inBlock = false;
  }
  const total = blocks + (inFence ? fencedBlocks : 0);
  return total > 0 ? total : null;
}

/**
 * The same verdict in the shape the step's transcript check returns, so
 * one gate suppresses both: `calls` and `taggedBlocks` are the block
 * count, `results` is 0 (a tagged call invents no result).
 */
export function detectTaggedToolCallText(
  text: string,
): FabricatedToolTranscript | null {
  const blocks = countTaggedToolCallBlocks(text);
  return blocks === null
    ? null
    : { calls: blocks, results: 0, taggedBlocks: blocks };
}
