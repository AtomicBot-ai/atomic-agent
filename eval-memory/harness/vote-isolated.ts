/**
 * E5 — isolated vote sub-call against the managed llama-server.
 *
 * The full `vote-runner` is intentionally bypassed here: we only
 * care about the model's **decision quality**, not its interaction
 * with `VoteStore`, `AbortController`, `AgentMetrics`, etc. (those
 * are covered by `vote-runner.test.ts` at unit level).
 *
 * The flow is:
 *   1. Build the canonical vote prompt with `buildVotePrompt`.
 *   2. Send the prompt + `VOTE_GRAMMAR` to llama-server.
 *   3. Parse the response with `parseVoteOutput`, threading an
 *      allowlist materialised from the candidates so the parser
 *      enforces invariant 18 verbatim (any `(kind, id)` the model
 *      hallucinates outside the surfaced set ends up in
 *      `rejected.notSurfaced` instead of silently scoring well).
 *
 * Nothing here writes to disk; the harness is pure-LLM-decision.
 */

import {
  VOTE_GRAMMAR,
  buildVotePrompt,
  parseVoteOutput,
  type ParsedVote,
  type ParseRejection,
  type VoteAllowlist,
  type VoteCandidate,
} from "../../src/memory/voting/index.js";

import type { LlmCompleteParams, LlmCompleteResult } from "./llm-client.js";

export interface IsolatedVoteInput {
  userMessage: string;
  assistantReply: string;
  candidates: ReadonlyArray<VoteCandidate>;
  sessionId?: string;
  signal?: AbortSignal;
}

export type IsolatedVoteOutcome =
  | {
      kind: "votes";
      votes: readonly ParsedVote[];
      rejected: readonly ParseRejection[];
      raw: string;
      durationMs: number;
    }
  | { kind: "none"; raw: string; durationMs: number }
  | { kind: "http_failed"; reason: string };

export interface IsolatedVoteDeps {
  llmComplete: (params: LlmCompleteParams) => Promise<LlmCompleteResult>;
  slotId?: number;
  temperature?: number;
  maxTokens?: number;
}

export async function runIsolatedVote(
  input: IsolatedVoteInput,
  deps: IsolatedVoteDeps,
): Promise<IsolatedVoteOutcome> {
  const prompt = buildVotePrompt({
    userMessage: input.userMessage,
    assistantReply: input.assistantReply,
    candidates: input.candidates,
  });
  const completionParams: LlmCompleteParams = {
    prompt,
    grammar: VOTE_GRAMMAR,
    slotId: deps.slotId ?? -1,
    temperature: deps.temperature ?? 0.3,
    maxTokens: deps.maxTokens ?? 256,
    cachePrompt: false,
  };
  if (input.sessionId !== undefined) completionParams.sessionId = input.sessionId;
  if (input.signal !== undefined) completionParams.signal = input.signal;
  let result: LlmCompleteResult;
  try {
    result = await deps.llmComplete(completionParams);
  } catch (err) {
    return {
      kind: "http_failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const raw = result.content;
  const allowlist = buildAllowlist(input.candidates);
  const parsed = parseVoteOutput(raw, { allowlist });
  if (parsed.kind === "none") {
    return { kind: "none", raw, durationMs: result.durationMs };
  }
  return {
    kind: "votes",
    votes: parsed.votes,
    rejected: parsed.rejected,
    raw,
    durationMs: result.durationMs,
  };
}

function buildAllowlist(candidates: ReadonlyArray<VoteCandidate>): VoteAllowlist {
  const memory = new Set<number>();
  const lesson = new Set<number>();
  const profile = new Set<number>();
  for (const c of candidates) {
    if (c.kind === "memory") memory.add(c.id);
    else if (c.kind === "lesson") lesson.add(c.id);
    else if (c.kind === "profile") profile.add(c.id);
  }
  return { memory, lesson, profile };
}
