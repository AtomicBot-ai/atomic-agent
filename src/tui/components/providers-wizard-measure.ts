/**
 * How wide the providers wizard's box needs to be, measured from the
 * strings it actually draws.
 *
 * The wizard renders `width="100%"` panels, so on its own it has no
 * opinion about width — but the onboarding surface centres it as a
 * block, and a centred block needs a measured width the same way every
 * other setup step does. The deterministic content lives here, beside
 * the measure, so the two cannot drift: the kind list and the embedding
 * catalogs are compiled into the binary, and the hint lines are
 * composed from fixed templates plus counters whose maximum is the
 * static list's own length.
 *
 * The live chat catalogs are the one thing deliberately not measured:
 * their rows arrive from the network mid-wizard, and every row and hint
 * on those screens is drawn `wrap="truncate-end"`, so an over-long
 * model id truncates inside the box instead of demanding a wider one —
 * sizing the whole surface to a string that may never arrive would let
 * the network move the screen.
 */

import { widestLine } from "../onboarding/centre-onboarding-block.js";
import { findProviderPreset } from "../providers/provider-presets.js";
import {
  listAimlapiEmbeddingModels,
  listOpenRouterEmbeddingModels,
} from "../providers/providers-model-options.js";
import {
  KIND_ROW_ORDER,
  type ProvidersWizardKindRow,
} from "../providers/providers-wizard-phases.js";
import type { ProvidersWizardKind } from "../providers/providers-wizard-state.js";

const KIND_LABELS: Record<ProvidersWizardKind, string> = {
  "claude-cli":
    "Claude Code subscription (drives your signed-in `claude` CLI — no API key)",
  "codex-cli":
    "OpenAI Codex subscription (drives your signed-in `codex` CLI — no API key)",
  openrouter: "OpenRouter (cloud chat + optional cloud embed)",
  aimlapi: "AI/ML API (1000+ models, OpenAI-compatible)",
  gemini: "Gemini (Google AI)",
  "openai-compatible": "OpenAI-compatible API (custom base URL)",
};

function labelForKindRow(row: ProvidersWizardKindRow): string {
  if (typeof row !== "object") return KIND_LABELS[row];
  const preset = findProviderPreset(row.presetId);
  if (!preset) return row.presetId;
  return preset.note ? `${preset.label} — ${preset.note}` : preset.label;
}

/**
 * One flat provider list, matching what other agent CLIs present: the
 * two kinds with built-in catalogs, then every known service (#69), then
 * the manual entry for anything not listed. Derived from
 * `KIND_ROW_ORDER` — the key bindings walk that same list, so a row's
 * label and its Enter action can never drift apart.
 */
export const KIND_OPTIONS: readonly { label: string }[] = KIND_ROW_ORDER.map(
  (row) => ({ label: labelForKindRow(row) }),
);

/** Shown while a save is off verifying the key with the provider. */
export const CHECKING_KEY_HINT =
  "checking the key with the provider… (Esc cancels)";

/** Two border cells plus one cell of padding either side of the box. */
const WIZARD_CHROME_COLUMNS = 4;
/** The cursor mark and its trailing gap before every pick-list row. */
const OPTION_MARK_COLUMNS = 2;

/** A pick list's hint line at the widest its counter can reach. */
function hintLine(moveHint: string, count: number, actionsHint: string): string {
  return `${moveHint} (${count}/${count}) · ${actionsHint}`;
}

export function measureProvidersWizard(): number {
  const openRouterRows = listOpenRouterEmbeddingModels();
  const aimlapiRows = listAimlapiEmbeddingModels();
  // A counter never exceeds its own list's length, so the widest hint a
  // screen can draw uses that screen's count, not the union's.
  const embeddingCount = Math.max(openRouterRows.length, aimlapiRows.length);
  const optionRows = [...KIND_OPTIONS, ...openRouterRows, ...aimlapiRows].map(
    (option) => OPTION_MARK_COLUMNS + option.label.length,
  );
  const textLines = widestLine([
    // The wizard opens the flow in `add` mode; a configure title carries
    // a provider id, which is operator data and wraps inside the box.
    "LLM provider — add provider",
    "Chat model (OpenRouter)",
    "Chat model (AI/ML API)",
    "Embedding backend",
    hintLine("j/k move", KIND_OPTIONS.length, "Enter pick · Esc cancel"),
    hintLine(
      "j/k move",
      embeddingCount,
      "PgUp/PgDn jump · Enter finish · Esc back",
    ),
    hintLine("j/k move", embeddingCount, CHECKING_KEY_HINT),
  ]);
  return WIZARD_CHROME_COLUMNS + Math.max(...optionRows, textLines);
}
