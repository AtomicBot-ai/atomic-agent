/**
 * The two numbers llama.cpp puts in an `exceed_context_size_error` body:
 *
 *   {"error":{"code":400,"type":"exceed_context_size_error",
 *     "message":"the request exceeds the available context size, try increasing it",
 *     "n_prompt_tokens":9134,"n_ctx":8192}}
 *
 * Current builds no longer repeat them in the message, so the sentence
 * alone tells the agent neither the window the server really runs with
 * nor how many tokens the server counted for the refused prompt. Both
 * are plain counts (no prompt text), safe to keep on an error object.
 */
export interface ContextOverflowCounts {
  /** `n_ctx`: the context window (per slot) the server enforced. */
  readonly contextWindow?: number;
  /** `n_prompt_tokens`: the server's own token count of the refused prompt. */
  readonly promptTokens?: number;
}

/** Bodies longer than this are not an error object worth parsing. */
const BODY_MAX_CHARS = 16_384;

/** Read the counts out of a raw error body. Pure; never throws. */
export function readContextOverflowCounts(rawBody: string): ContextOverflowCounts {
  if (rawBody.length === 0 || rawBody.length > BODY_MAX_CHARS) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object") return {};
  const root = parsed as Record<string, unknown>;
  const error = root["error"];
  const holder =
    error !== null && typeof error === "object"
      ? (error as Record<string, unknown>)
      : root;
  const contextWindow = positiveInt(holder["n_ctx"]);
  const promptTokens = positiveInt(holder["n_prompt_tokens"]);
  return {
    ...(contextWindow !== null ? { contextWindow } : {}),
    ...(promptTokens !== null ? { promptTokens } : {}),
  };
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}
