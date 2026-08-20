/**
 * Which model the credential check should spend a token on.
 *
 * The check has to prove the account can actually pay, so a free model
 * is the wrong instrument: `openrouter/auto` and every `:free` slug
 * answer 200 on a key with zero credit, which would turn the balance
 * check into a formality. Where the catalog carries prices we take the
 * cheapest *paid* model; where it does not, the model the operator just
 * chose is the honest probe — it is the one they are about to use.
 */

import { AIMLAPI_DEFAULT_CHAT_MODEL } from "../aimlapi/aimlapi-models-catalog.js";
import { GEMINI_DEFAULT_CHAT_MODEL } from "../gemini/gemini-provider.js";
import { listOpenRouterChatPicks } from "../openrouter/fetch-openrouter-chat-catalog.js";
import type { ProviderVerifyKind } from "./verify-types.js";

/** More than two candidates would turn a check into a shopping trip. */
const MAX_PROBE_MODELS = 2;

export function pickProbeModels(input: {
  kind: ProviderVerifyKind;
  /** The model the wizard is about to save, when it knows one. */
  selectedModelId?: string | null;
  /** Ids already listed from `/v1/models`, when that call was made. */
  listedModelIds?: readonly string[];
}): readonly string[] {
  const selected = input.selectedModelId?.trim() || null;
  const listed = input.listedModelIds?.filter((id) => id.length > 0) ?? [];

  if (input.kind === "openrouter") {
    return dedupe([cheapestPaidOpenRouterModel(), selected]);
  }
  if (input.kind === "aimlapi") {
    // The AI/ML API catalog carries no prices, so there is nothing to
    // rank; the operator's own pick is the closest thing to a known cost.
    return dedupe([selected, AIMLAPI_DEFAULT_CHAT_MODEL]);
  }
  if (input.kind === "gemini") {
    return dedupe([selected, GEMINI_DEFAULT_CHAT_MODEL]);
  }
  // An arbitrary OpenAI-compatible endpoint has no catalog we can price,
  // and its `/v1/models` list is already on hand from the model step.
  return dedupe([selected, listed[0] ?? null]);
}

/**
 * Cheapest OpenRouter chat model with a non-zero input price, from the
 * live catalog when it has been fetched and the static one otherwise.
 * Ties break on output price, then id, so the choice is stable across
 * runs rather than dependent on catalog order.
 */
export function cheapestPaidOpenRouterModel(): string | null {
  let best: { id: string; input: number; output: number } | null = null;
  for (const pick of listOpenRouterChatPicks()) {
    const pricing = pick.entry.pricing;
    if (!pricing || !(pricing.input > 0)) continue;
    const candidate = {
      id: pick.id,
      input: pricing.input,
      output: pricing.output ?? 0,
    };
    if (!best || isCheaper(candidate, best)) best = candidate;
  }
  return best?.id ?? null;
}

function isCheaper(
  a: { id: string; input: number; output: number },
  b: { id: string; input: number; output: number },
): boolean {
  if (a.input !== b.input) return a.input < b.input;
  if (a.output !== b.output) return a.output < b.output;
  return a.id.localeCompare(b.id) < 0;
}

function dedupe(ids: readonly (string | null)[]): readonly string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length === MAX_PROBE_MODELS) break;
  }
  return out;
}
