/**
 * Micro-prompt builder for the async end-of-turn reflection call. The
 * prompt is intentionally split into two parts:
 *
 *  - a **stable prefix** that is a byte-stable module-level constant so
 *    the dedicated reflection slot on llama-server can reuse its KV
 *    cache across every call. Nothing in the prefix ever varies.
 *  - a **variable tail** that carries the trimmed last USER / ASSISTANT
 *    messages plus the `### output` marker.
 *
 * The prompt is deliberately tiny (~150 tokens of prefix + up to ~500
 * tokens of tail) so reflection stays cheap enough to run at the end of
 * every turn without affecting user-visible latency.
 */

/**
 * Hard cap on the USER / ASSISTANT excerpts injected into the tail.
 * Protects the reflection slot from blowing its KV cache on pathological
 * long replies. Characters, not tokens — tokenisation is left to the
 * server.
 */
export const REFLECTION_MESSAGE_CHAR_CAP = 1_000;

/**
 * Fixed reflection preamble. Changing this string invalidates the
 * reflection slot's KV cache on the next call — treat edits the same
 * way we treat edits to the main stable prefix.
 */
export const REFLECTION_STABLE_PREFIX = `You are a memory extractor for a personal assistant.
Given the last USER and ASSISTANT messages, output durable facts about the user that should be remembered across sessions.
Rules:
- Only durable facts explicitly stated by the user or that the user asked to remember.
- Skip trivia, chit-chat, weather, transient moods, facts about the AI itself.
- Prefer short snake_case keys (e.g. name, timezone, trip_lisbon_plan).
- Keep each value under 200 characters.
- If there is nothing worth remembering, output exactly: NONE
- Otherwise output one or more lines of the form: SET key=value
`;

export interface ReflectionPromptInput {
  userMessage: string;
  assistantReply: string;
}

/**
 * Build the full reflection prompt. The `stable prefix` is always
 * identical across calls; only the tail varies. The caller feeds this
 * through `llmComplete` with the reflection grammar.
 */
export function buildReflectionPrompt(input: ReflectionPromptInput): string {
  const user = clampMessage(input.userMessage);
  const assistant = clampMessage(input.assistantReply);
  return `${REFLECTION_STABLE_PREFIX}\nUSER: ${user}\nASSISTANT: ${assistant}\n\n### output\n`;
}

function clampMessage(raw: string): string {
  const normalised = raw.replace(/\s+/g, " ").trim();
  if (normalised.length <= REFLECTION_MESSAGE_CHAR_CAP) return normalised;
  return `${normalised.slice(0, REFLECTION_MESSAGE_CHAR_CAP - 1)}…`;
}
