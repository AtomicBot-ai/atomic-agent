import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import type { GitRunResult } from "./git-runner.js";

/**
 * What a git failure is compressed with, here and in
 * `gitFailureResult` for the network verbs. git's important failures
 * are lists — "error: Your local changes to the following files would
 * be overwritten by merge:" and one line per file, or a run of
 * "CONFLICT (content): Merge conflict in <path>" — and on the
 * compressor's defaults they are unusable: a five-file conflict is 604
 * characters and loses both its last two paths and the sentence that
 * says what to do ("Automatic merge failed; fix conflicts and then
 * commit the result."), which is the only line in the block the model
 * can act on.
 *
 * Unlike the refusals this content is unbounded, so something has to be
 * dropped, and it is the head: git prints its remedy last, and the head
 * is already rescued for the whole "error:" family by
 * `extractSignature`, which repeats git's first matching line as a
 * `key:` prefix. That makes the line cap the one that has to bind. If
 * the character cap binds first the compressor head-slices instead, and
 * the head slice cuts the end — the remedy — which is the bug we are
 * fixing. So these two are chosen together: 20 tail lines carries the
 * `CONFLICT` line for all ten files of a ten-file conflict (git prints
 * two lines per file, and what falls off the head is the redundant
 * `Auto-merging` line for the first of them) or a seventeen-path
 * "would be overwritten" list, and 2000 is the smallest character cap
 * at which 20 lines of deep repository paths plus the 185-character
 * signature still fit — 1951 for the worst shape measured. Past the
 * line cap the compressor announces what it dropped as "… [omitted N
 * lines]", so the model still knows the list was longer.
 */
export const GIT_FAILURE_SUMMARY_CHARS = 2000;
export const GIT_FAILURE_TAIL_LINES = 20;

/**
 * Structured failure for the git write tools. The read tools throw on a
 * non-zero exit because their failures are almost always a bad argument;
 * a write verb fails for reasons the model must reason about and recover
 * from ("nothing to commit", "would be overwritten", "please tell me who
 * you are"), so those come back as a `status: "error"` result whose
 * output carries git's own words, not as an exception that ends the step.
 */
export function buildGitErrorResult(
  tool: string,
  message: string,
  details: Record<string, unknown> = {},
): CompressedToolResult {
  return compressToolResult(
    {
      tool,
      status: "error",
      output: message,
      details: { ...details, error: message },
    },
    {
      maxSummaryLength: GIT_FAILURE_SUMMARY_CHARS,
      maxTailLines: GIT_FAILURE_TAIL_LINES,
    },
  );
}

/**
 * git's stderr verbatim (falling back to stdout, where `git commit`
 * explains "nothing to commit"), or the exit code when both are silent.
 */
export function describeGitFailure(result: GitRunResult): string {
  const shown = result.args.filter((arg) => arg !== "--no-pager").join(" ");
  if (result.timedOut) {
    return `git ${shown} timed out after ${result.durationMs}ms`;
  }
  const text = [result.stderr.trim(), result.stdout.trim()]
    .filter((part) => part.length > 0)
    .join("\n");
  return text || `git ${shown} exited with ${result.exitCode}`;
}
