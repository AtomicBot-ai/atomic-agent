/**
 * A completion that continued atag's own TEXT transcript instead of
 * calling tools.
 *
 * History reaches the model as text inside one user message
 * (`renderTurnForPrompt`): `assistant_tool_call: <tool> {json}` and
 * `tool_result[<tool> <ok|error>]: <summary>` lines, with native tool
 * schemas attached. A model that loses the thread of native function
 * calling (Gemini Flash did, repeatedly, in the harness benchmark) keeps
 * writing that text — invented `tool_result[os.fs.write ok]` lines, an
 * invented test run printing "ALL ASSERTIONS PASSED!" — and reports work
 * that never happened.
 *
 * Two callers apply the same line rules, which is why they live here and
 * not in the step executor:
 *  - the step executor judges a FINISHED completion
 *    (`detectFabricatedToolTranscript`) and refuses its reply;
 *  - the OpenAI-compatible stream consumer watches a completion WHILE it
 *    streams (`createFabricatedTranscriptWatcher`) and ends it early, so
 *    a derailed model is not left to run to the provider's output limit.
 */

/**
 * Line shapes of the text transcript. A bare `tool_call:` is accepted
 * too — it is what a model abbreviating the prefix writes.
 */
const TEXT_TOOL_CALL_LINE = /^\s*(?:assistant_)?tool_call:\s*[\w.:-]+\s*[{[]/;
const TEXT_TOOL_RESULT_LINE = /^\s*tool_result\[[\w.:-]+ (?:ok|error)\]:/;
const FENCE_LINE = /^\s*(?:```|~~~)/;

/**
 * Transcript lines (outside closed code fences) it takes to call a
 * completion's text a fabricated tool transcript. One line is a quote;
 * two are a pattern.
 */
export const FABRICATED_TRANSCRIPT_MIN_LINES = 2;

/**
 * Transcript lines (outside any code fence) that end a completion WHILE
 * it streams.
 *
 * Higher than `FABRICATED_TRANSCRIPT_MIN_LINES` because this decision is
 * irreversible: the request is aborted and whatever the model would have
 * written next — possibly a native tool call — is gone. Three invented
 * call/result pairs are not a quote.
 *
 * Low enough to matter. Benchmark run 11, request cloud-00312 (Gemini
 * 3.8 Flash via OpenRouter): 87,228 characters of plain content holding
 * 45 fabricated tool-call lines and no native call, stopped only by the
 * provider — `finish_reason: length` after 33,678 output tokens, 297 s,
 * $0.129. A v0.6.0 cloud-only run did the same (30,892 tokens, 180 s,
 * $0.126). At six lines such a stream ends a few hundred tokens in.
 */
export const STREAM_FABRICATION_ABORT_MIN_LINES = 6;

/** Counts of tool-call and tool-result lines a completion wrote as text. */
export interface FabricatedToolTranscript {
  calls: number;
  results: number;
}

/**
 * The line rules, one line at a time. Both callers drive this, so the
 * finished-text detector and the stream watcher cannot drift apart.
 *
 *  - a line must BEGIN with the prefix, so prose that mentions one
 *    ("the `tool_result[os.fs.read ok]` line shows…"), a bullet or a
 *    block quote does not count;
 *  - lines inside a CLOSED fenced code block are ignored — that is how a
 *    legitimate answer quotes the format;
 *  - JSON tool-call arrays (the grammar transport's body) never start a
 *    line with either prefix.
 */
interface TranscriptLineScanner {
  pushLine(line: string): void;
  /**
   * Lines counted outside any fence. Final: nothing that follows can take
   * them back, which is what makes them safe to act on mid-stream.
   */
  settled(): FabricatedToolTranscript;
  /**
   * The count for text that ENDS here: a fence still open is not a
   * quote, so its lines count too.
   */
  atEnd(): FabricatedToolTranscript;
}

function createTranscriptLineScanner(): TranscriptLineScanner {
  let calls = 0;
  let results = 0;
  let inFence = false;
  let fencedCalls = 0;
  let fencedResults = 0;
  return {
    pushLine(line) {
      if (FENCE_LINE.test(line)) {
        if (inFence) {
          // Closed: whatever was inside was a quote.
          fencedCalls = 0;
          fencedResults = 0;
        }
        inFence = !inFence;
        return;
      }
      const isCall = TEXT_TOOL_CALL_LINE.test(line);
      const isResult = !isCall && TEXT_TOOL_RESULT_LINE.test(line);
      if (inFence) {
        if (isCall) fencedCalls += 1;
        if (isResult) fencedResults += 1;
        return;
      }
      if (isCall) calls += 1;
      if (isResult) results += 1;
    },
    settled: () => ({ calls, results }),
    atEnd: () =>
      inFence
        ? { calls: calls + fencedCalls, results: results + fencedResults }
        : { calls, results },
  };
}

/**
 * Detect a completion that continued the text transcript instead of
 * calling tools: at least `FABRICATED_TRANSCRIPT_MIN_LINES` lines that
 * START with a rendered tool-call or tool-result prefix, outside closed
 * code fences (see `TranscriptLineScanner` for the guards). One line
 * alone never triggers.
 *
 * Callers pass the completion's text with reasoning removed: a model's
 * scratch space may legitimately walk through earlier results.
 */
export function detectFabricatedToolTranscript(
  text: string,
): FabricatedToolTranscript | null {
  if (!text.includes("tool_call:") && !text.includes("tool_result[")) {
    return null;
  }
  const scanner = createTranscriptLineScanner();
  for (const line of text.split(/\r?\n/)) scanner.pushLine(line);
  const { calls, results } = scanner.atEnd();
  return calls + results >= FABRICATED_TRANSCRIPT_MIN_LINES
    ? { calls, results }
    : null;
}

/** Incremental form of the detector for plain content that is still streaming. */
export interface FabricatedTranscriptWatcher {
  /**
   * Feed the next slice of plain content (never the reasoning channel).
   * Returns the settled counts once they reach the watcher's threshold,
   * `null` before that.
   */
  push(delta: string): FabricatedToolTranscript | null;
}

const INLINE_REASONING_OPEN = "<think>";
const INLINE_REASONING_CLOSE = "</think>";

/**
 * Watch streamed content for a fabricated transcript.
 *
 * Conservative by construction — every count it acts on is one
 * `detectFabricatedToolTranscript` would also make over the text so far
 * and over any continuation of it:
 *  - only COMPLETE lines are judged; the partial last line waits for its
 *    newline;
 *  - only lines outside any fence count (`settled`). A fence still open
 *    mid-stream may yet close and turn out to be a quoted example, so its
 *    lines are not acted on — a model fabricating inside a fence it never
 *    closes is left to the finished-completion check;
 *  - lines inside an inline `<think>` … `</think>` block are skipped. The
 *    step executor removes inline reasoning before it runs the detector,
 *    and a provider that streams reasoning inline in `content` would
 *    otherwise have a model's scratch space judged as its answer.
 *
 * Linear in the streamed length: each delta without a newline is only
 * appended to the pending line.
 */
export function createFabricatedTranscriptWatcher(
  minLines: number = STREAM_FABRICATION_ABORT_MIN_LINES,
): FabricatedTranscriptWatcher {
  const scanner = createTranscriptLineScanner();
  let pending = "";
  let inReasoning = false;
  return {
    push(delta) {
      if (!delta.includes("\n")) {
        pending += delta;
        return null;
      }
      const lines = (pending + delta).split("\n");
      pending = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (inReasoning) {
          if (line.includes(INLINE_REASONING_CLOSE)) inReasoning = false;
          continue;
        }
        const open = line.lastIndexOf(INLINE_REASONING_OPEN);
        if (open >= 0 && line.indexOf(INLINE_REASONING_CLOSE, open) < 0) {
          inReasoning = true;
          continue;
        }
        scanner.pushLine(line);
      }
      const counts = scanner.settled();
      return counts.calls + counts.results >= minLines ? counts : null;
    },
  };
}
