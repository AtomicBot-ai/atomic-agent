import {
  MODEL_TIERS,
  MODEL_TIER_LABELS,
  MODEL_TIER_ORDER,
} from "../llm/provider/presets/model-tiers.js";
import { sendJson, type HttpHandler } from "./request-context.js";

/**
 * `GET /api/model-tiers` — the Cheap / Balanced / Best picks per provider
 * (ATO-32), so the desktop's model picker shows the same short list as
 * the TUI without a copy of its own. Static data: no config, no keys.
 *
 * `{tiers: {<key>: [{tier, label, model}]}}`, keyed like
 * `modelTierKey` (provider kind, or `<cli>-cli` for a subscription entry).
 */
export function createModelTiersHandler(): HttpHandler {
  return async (_req, res) => {
    const tiers: Record<string, Array<{ tier: string; label: string; model: string }>> = {};
    for (const [key, byTier] of Object.entries(MODEL_TIERS)) {
      tiers[key] = MODEL_TIER_ORDER.map((tier) => ({
        tier,
        label: MODEL_TIER_LABELS[tier],
        model: byTier[tier],
      }));
    }
    sendJson(res, 200, { tiers });
  };
}
