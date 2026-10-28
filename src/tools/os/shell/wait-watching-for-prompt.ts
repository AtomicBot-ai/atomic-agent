import type { CommandJob, CommandJobWait } from "../../../sandbox/command-job.js";
import {
  detectInteractivePrompt,
  type InteractivePrompt,
} from "./interactive-prompt.js";

/** How often a running command's output is looked at. */
export const PROMPT_POLL_MS = 1_000;

/**
 * How long the output must stay unchanged, ending at a prompt, before
 * the command is taken to be waiting for a person. A build that pauses
 * between steps prints again well within this.
 */
export const PROMPT_QUIET_MS = 4_000;

export interface PromptWatchResult {
  outcome: CommandJobWait;
  /** Set when the wait ended because the command sits at a prompt. */
  prompt: InteractivePrompt | null;
}

/**
 * `job.waitFor(timeoutMs, signal)`, but in slices: after each one the
 * end of the output is checked, and a command that went quiet at a
 * sign-in or a question comes back with `prompt` set instead of sitting
 * there until the timeout (ATO-1252). A spawn failure rejects, as
 * `waitFor` does.
 */
export async function waitWatchingForPrompt(
  job: CommandJob,
  timeoutMs: number,
  signal: AbortSignal,
  timing: { pollMs?: number; quietMs?: number } = {},
): Promise<PromptWatchResult> {
  const pollMs = timing.pollMs ?? PROMPT_POLL_MS;
  const quietMs = timing.quietMs ?? PROMPT_QUIET_MS;
  const deadline =
    timeoutMs > 0 && Number.isFinite(timeoutMs)
      ? Date.now() + timeoutMs
      : Number.POSITIVE_INFINITY;
  let lastSeen = "";
  let lastChange = Date.now();
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { outcome: "elapsed", prompt: null };
    const outcome = await job.waitFor(Math.min(pollMs, remaining), signal);
    if (outcome !== "elapsed") return { outcome, prompt: null };
    const output = job.output();
    // Length and tail together: a capped stream keeps its length while
    // its tail still moves.
    const seen = `${output.stdout.length}:${output.stderr.length}:${output.stdout.slice(-200)}:${output.stderr.slice(-200)}`;
    const now = Date.now();
    if (seen !== lastSeen) {
      lastSeen = seen;
      lastChange = now;
      continue;
    }
    if (now - lastChange < quietMs) continue;
    const prompt =
      detectInteractivePrompt(output.stdout, "running") ??
      detectInteractivePrompt(output.stderr, "running");
    if (prompt !== null) return { outcome: "elapsed", prompt };
  }
}
