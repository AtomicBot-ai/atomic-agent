import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import type { GitRunResult } from "./git-runner.js";

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
  return compressToolResult({
    tool,
    status: "error",
    output: message,
    details: { ...details, error: message },
  });
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
