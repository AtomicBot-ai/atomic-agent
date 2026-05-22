import { isReferentialMessage } from "./referential-detector.js";

/**
 * Pluggable gate for the v2.5 query rewriter (config v20).
 *
 * Decides whether to spend an LLM call rewriting the current user
 * message. Implementations are async so the embedding gate can call
 * the embedding daemon without blocking the event loop on warm-up.
 */

export type RewriterGateMode = "heuristic" | "embedding" | "always";

export interface RewriterGateCheckInput {
  message: string;
  historyTurnCount: number;
  signal: AbortSignal;
}

export interface RewriterGate {
  readonly name: RewriterGateMode;
  check(input: RewriterGateCheckInput): Promise<boolean>;
}

/** Word-list gate — 16 whitespace-tokenized languages (see referential-detector). */
export function createHeuristicGate(): RewriterGate {
  return {
    name: "heuristic",
    async check({ message, historyTurnCount }) {
      return isReferentialMessage(message, historyTurnCount);
    },
  };
}

/** Debug / eval — fires whenever history is non-empty (runner still skips empty history). */
export function createAlwaysGate(): RewriterGate {
  return {
    name: "always",
    async check() {
      return true;
    },
  };
}
