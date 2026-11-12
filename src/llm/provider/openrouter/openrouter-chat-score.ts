/**
 * Ranking, not gatekeeping, for OpenRouter's live chat catalog.
 *
 * This used to return -1 for every `anthropic/*` id and everything
 * matching `/gemini/i`, which removed ~40 currently served models — the
 * whole Claude 5 and Gemini 3.x lines — from the picker with no way for
 * an operator to get them back. Nothing in the runtime needs that: both
 * families speak the same OpenAI-shaped `/v1/chat/completions`
 * OpenRouter exposes for everything else, and `native_tools` transport
 * is what the picker already requires via `hasTools`. The families are
 * scored instead, so the models this agent is tuned for sort to the top.
 *
 * Family bonuses name a generation *and everything after it*
 * (`gpt-5` and later, `qwen3.6` and later, `kimi-k3`…), never one
 * version: pinned to `gpt-5.` / `qwen3.7` / `kimi-k2.6`, a new release
 * (GPT-6, Qwen 4, Kimi K3) got no bonus and sank below the model it
 * replaces (ATO-1340). Within a tie the newer row (OpenRouter's
 * `created`) comes first.
 *
 * A negative score is reserved for rows that genuinely cannot be used:
 * non-chat surfaces (embeddings, rerank, TTS), batch-only variants, and
 * models that explicitly advertise no tool support.
 */

export type OpenRouterScoredRow = {
  id?: string;
  context_length?: number;
  created?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
};

/** A generation number at or past `from`: `[5-9]` or any two digits. */
const GPT_FROM_5 = /gpt-(?:[5-9]|[1-9][0-9])(?![0-9])/i;
const QWEN_FROM_3_6 = /qwen(?:3\.(?:[6-9]|[1-9][0-9])|(?:[4-9]|[1-9][0-9])(?![0-9]))/i;
const CLAUDE_FROM_5 =
  /claude-(?:opus|sonnet|fable|haiku)-(?:[5-9]|[1-9][0-9])(?![0-9])|claude-opus-4\.8/i;
const GEMINI_FROM_3 = /gemini-(?:[3-9]|[1-9][0-9])(?![0-9])/i;
const DEEPSEEK_FROM_V3 = /deepseek.*v(?:[3-9]|[1-9][0-9])(?![0-9])/i;
const KIMI_FROM_K2_6 = /kimi-k(?:2\.(?:[6-9]|[1-9][0-9])|(?:[3-9]|[1-9][0-9])(?![0-9]))/i;
const GLM_FROM_5 = /z-ai\/glm-(?:[5-9]|[1-9][0-9])(?![0-9])|z-ai\/glm-4\.7-flash/i;

/** USD per million tokens from OpenRouter's per-token string. */
export function pricePerMillion(tokenPrice: string | undefined): number {
  const n = parseFloat(tokenPrice ?? "0");
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 1_000_000 * 100) / 100;
}

/**
 * Tool support as advertised by the API.
 *
 * A missing or empty `supported_parameters` means the response says
 * nothing, not that the model lacks tools. Treating silence as a "no"
 * is what emptied the aimlapi catalog when that provider dropped its
 * capability field, so this reader keeps the two cases apart.
 */
function hasTools(m: OpenRouterScoredRow): boolean {
  if (!Array.isArray(m.supported_parameters)) return true;
  if (m.supported_parameters.length === 0) return true;
  return m.supported_parameters.includes("tools");
}

export function scoreChat(m: OpenRouterScoredRow): number {
  const id = m.id ?? "";
  if (!id) return -1;
  if (/qwen3\.5/i.test(id)) return -1;
  if (/embed|rerank|moderation|ocr|tts|transcribe/i.test(id)) return -1;
  // Batch-only routes answer later, not in a turn.
  if (/:batch$/i.test(id)) return -1;
  if (!hasTools(m)) return -1;
  let s = 10;
  const ctx = m.context_length ?? 0;
  if (ctx >= 1_000_000) s += 8;
  else if (ctx >= 200_000) s += 5;
  if (QWEN_FROM_3_6.test(id)) s += 20;
  if (GPT_FROM_5.test(id)) s += 15;
  if (CLAUDE_FROM_5.test(id)) s += 18;
  else if (id.startsWith("anthropic/")) s += 6;
  if (GEMINI_FROM_3.test(id)) s += 14;
  else if (/gemini/i.test(id)) s += 4;
  if (DEEPSEEK_FROM_V3.test(id)) s += 10;
  if (KIMI_FROM_K2_6.test(id)) s += 12;
  else if (/kimi-k2/i.test(id)) s += 8;
  if (GLM_FROM_5.test(id)) s += 11;
  else if (/z-ai\/glm/i.test(id)) s += 7;
  if (/4o-mini|3\.5-turbo/i.test(id)) s -= 8;
  if (/thinking|reasoner|r1/i.test(id)) s -= 5;
  const pin = pricePerMillion(m.pricing?.prompt);
  if (pin > 0 && pin < 1) s += 3;
  return s;
}

/**
 * Picker order: higher score first, then the newer row, then the id so
 * the order is stable across fetches.
 */
export function compareChatRows(
  a: OpenRouterScoredRow,
  b: OpenRouterScoredRow,
): number {
  const byScore = scoreChat(b) - scoreChat(a);
  if (byScore !== 0) return byScore;
  const byCreated = (b.created ?? 0) - (a.created ?? 0);
  if (byCreated !== 0) return byCreated;
  return (a.id ?? "").localeCompare(b.id ?? "");
}
