import { estimateTokens } from "../../prompt/token-budget.js";
import { TransportError } from "../reliability/llm-failures.js";

/** Estimates only; includes framing and reserves rather than silently dropping content. */
export function assertContextCapacity(input: unknown, budget: { window: number | null; replyReserve: number }): void {
  if (budget.window === null) return;
  const tokens = estimateTokens(typeof input === "string" ? input : JSON.stringify(input));
  const required = tokens + budget.replyReserve + 1024;
  if (required > budget.window) throw new TransportError(
    `Full cloud context exceeds context window: ${budget.window} tokens. Estimated ${tokens} input + ${budget.replyReserve} reply reserve + 1024 safety tokens. No content was truncated.`,
    400, "context-capacity",
  );
}
