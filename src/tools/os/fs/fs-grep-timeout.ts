/**
 * Partial results for an `os.fs.grep` search that ripgrep's timeout cut
 * short.
 *
 * The command runner kills ripgrep at `timeoutMs` and resolves with what
 * it captured, `exitCode: null` and `timedOut: true`. That stdout is
 * already a run of complete NDJSON records (plus at most one cut-off
 * line, which the parser skips), so the matches found so far are kept
 * and the result leads with a note, the same shape `os.fs.glob` uses
 * when its walk budget runs out (see fs-walk-budget.ts).
 */
import {
  retainToolOutput,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";

export interface GrepTimeoutStop {
  /** How long ripgrep ran before the runner stopped it. */
  elapsedMs: number;
}

/** The line the model reads when a search stopped at the time limit. */
export function describeGrepTimeout(stop: GrepTimeoutStop): string {
  const seconds = Math.round(stop.elapsedMs / 100) / 10;
  return (
    `[partial results: search stopped after ${seconds} s (time limit reached); ` +
    "files not yet searched are missing and the last one may be incomplete. Narrow the pattern, the path or the glob and retry.]"
  );
}

/**
 * Mark a formatted grep result as partial: `truncated`, the stop fields
 * in `details`, and the note leading `summary` and the full output. The
 * compressor keeps the tail of a long result and then the head of that,
 * so a note at either end of `output` could be cut; prefixing after
 * compression keeps it in view.
 */
export function withTimeoutNote(
  result: CompressedToolResult,
  stop: GrepTimeoutStop,
): CompressedToolResult {
  const note = describeGrepTimeout(stop);
  const prefix = `${note}\n`;
  return retainToolOutput(
    result,
    {
      ...result,
      summary: `${prefix}${result.summary}`,
      truncated: true,
      details: {
        ...result.details,
        truncated: true,
        stoppedBy: "time",
        elapsedMs: stop.elapsedMs,
        note,
      },
    },
    { prefix, truncated: true },
  );
}
