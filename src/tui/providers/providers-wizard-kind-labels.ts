import { findProviderPreset } from "./provider-presets.js";
import type { ProvidersWizardKindRow } from "./providers-wizard-phases.js";
import type { ProvidersWizardKind } from "./providers-wizard-state.js";

/**
 * Labels and match keys for the `pick_kind` rows.
 *
 * These used to live in `providers-wizard.tsx`, next to the render that
 * consumed them. The search box moved them down here: the key bindings
 * decide which row Enter takes from a filtered list, and they can only
 * agree with the screen if both filter the same labels. The type import
 * from `providers-wizard-phases` is erased at compile time, so nothing
 * here participates in that module's evaluation.
 */
const KIND_LABELS: Record<ProvidersWizardKind, string> = {
  "claude-cli":
    "Claude Code subscription (drives your signed-in `claude` CLI — no API key)",
  "codex-cli":
    "OpenAI Codex subscription (drives your signed-in `codex` CLI — no API key)",
  openrouter: "OpenRouter (cloud chat + optional cloud embed)",
  aimlapi: "AI/ML API (aimlapi.com — 500+ models, OpenAI-compatible)",
  gemini: "Gemini (Google AI)",
  "openai-compatible": "OpenAI-compatible API (custom base URL)",
};

export function labelForKindRow(row: ProvidersWizardKindRow): string {
  if (typeof row !== "object") return KIND_LABELS[row];
  const preset = findProviderPreset(row.presetId);
  if (!preset) return row.presetId;
  return preset.note ? `${preset.label} — ${preset.note}` : preset.label;
}

/**
 * The row's stable name, which is the second thing the search matches
 * on. A preset row answers to its own id (`groq`, `fireworks`) rather
 * than to `openai-compatible`, which is only the config kind it saves as.
 */
export function kindRowId(row: ProvidersWizardKindRow): string {
  return typeof row === "object" ? row.presetId : row;
}
