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
Given the last USER and ASSISTANT messages, output durable things worth remembering across sessions.

Two output channels:
- SET key=value    atomic key/value facts about the user (name, timezone, language, preferences, stated goals). Rendered into every future prompt, so keep them small and canonical.
- NOTE body        freeform episodic observations worth recalling later (decisions taken, project conventions discovered, debugging findings, commitments). Stored but NOT auto-rendered; the agent looks them up on demand.

SET has two flavours:
- Default (pinned) — the fact is always rendered into \`### profile\`. Use for truly identity-level facts that apply to most turns (name, primary language, timezone).
- Contextual — the fact is ONLY rendered when a keyword hits the current user message. Use for rare/large context (deploy commands, per-feature preferences, per-project env snippets). Emit as: SET key=value [pinned=false; keywords=a,b,c]. The [...] marker MUST be on the same line, keywords comma-separated, lowercase, 1–8 entries.

Bi-temporal versioning:
- Every SET preserves history automatically — re-writing the same key never erases the previous version. The earlier value is still available via the \`memory.profile.history\` tool.
- When the user explicitly switches a value ("actually let's use X now"), add a supersession marker so future readers can see the intent: SET key=new_value [valid_from=now; supersedes=key]. Same-key supersession (e.g. language: ru → en) makes the chain explicit; cross-key supersession (e.g. SET full_name=Alex [supersedes=name]) marks both rows in a single write.
- The valid_from token must be the literal "now"; the runtime stamps the actual timestamp.

Rules:
- Only durable content explicitly stated by the user or that the user asked to remember.
- Skip trivia, chit-chat, weather, transient moods, facts about the AI itself.
- Use SET for anything that looks like a stable attribute of the user. Prefer short snake_case keys (e.g. name, timezone, trip_lisbon_plan). Keep each SET value under 200 characters.
- Prefer contextual SET when the fact is valuable only in a specific topic. If unsure, default to pinned SET.
- Use NOTE for anything episodic or narrative that does not fit a single key. Keep each NOTE body under 500 characters. A NOTE may end with an optional tag marker " [tags=a,b,c]" (lowercase, snake or hyphen, up to 8 tags).
- If a SET already captures the fact, do not also emit a NOTE repeating it.
- If there is nothing worth remembering, output exactly: NONE
- Otherwise output up to six lines total; each line is either "SET key=value" (optionally followed by a pinned/keywords marker) or "NOTE body".
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
