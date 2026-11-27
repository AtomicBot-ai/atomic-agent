import type { LlmContextOverflow } from "../../error-reporting/index.js";
import { contextCompactionRejection } from "../../agent/turn/compaction-recovery.js";
import { ContextWindowExhaustedError } from "../../agent/turn/overflow-compaction.js";
import {
  readContextLengthFromRejection,
  readServerContextCounts,
} from "../../llm/reliability/request-size-rejection.js";

/** How far down `cause` the overflow and its wrapper are looked for. */
const MAX_CAUSE_DEPTH = 6;

/**
 * What a failed turn's context-size refusal says, when there is one on
 * the error's `cause` chain (ATO-2420): the window the server named
 * (`n_ctx`, or the window in an OpenAI-style sentence), the server's own
 * count of the refused prompt (`n_prompt_tokens`), and how far the turn's
 * one overflow compaction got. Beside the `prompt_*` budget tags it tells
 * "our window was wrong" (`prompt_window` above the server's) from "our
 * estimate undercounted" (same window, server count above
 * `prompt_total_tokens`). Counts and a fixed word only.
 */
export function readContextOverflow(error: unknown): LlmContextOverflow | undefined {
  const rejection = contextCompactionRejection(error);
  if (rejection === null) return undefined;
  const exhausted = findExhausted(error);
  return {
    serverWindow: readContextLengthFromRejection(rejection),
    serverPromptTokens: readServerContextCounts(rejection).promptTokens ?? null,
    compaction:
      exhausted === null
        ? "not_attempted"
        : exhausted.compacted
          ? "compacted_still_too_large"
          : "could_not_free_room",
  };
}

function findExhausted(error: unknown): ContextWindowExhaustedError | null {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (current instanceof ContextWindowExhaustedError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
