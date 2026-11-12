import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { isGroqPlanTpmLimit } from "../provider/openai/groq-plan-limit.js";

/** How far down a `cause` chain a wrapped provider refusal is looked for. */
const MAX_CAUSE_DEPTH = 6;

/**
 * A failure that is the limit of the user's provider plan, not a defect
 * of the agent: the user is told what to do in chat, and error reporting
 * leaves it out (ATO-1283). Today that is Groq's 413 for a request over
 * the plan's tokens-per-minute allowance, with Groq's numbers in the
 * answer (`isGroqPlanTpmLimit`). A bare 413 is still reported.
 *
 * The runtime's `loop_failed` error is the step's `TransportError` with
 * the `OpenAiHttpError` on its `cause`, so the chain is walked.
 */
export function isExpectedProviderLimit(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof OpenAiHttpError) return isGroqPlanTpmLimit(current);
    if (!(current instanceof Error)) return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
