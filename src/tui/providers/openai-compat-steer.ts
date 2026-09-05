import { looksLikeOllamaUrl } from "../../llm/describe-llama-health-failure.js";
import { presetNeedsKeyScreen } from "./providers-wizard-phases.js";
import {
  createProvidersWizardState,
  type ProvidersWizardState,
} from "./providers-wizard-state.js";

/**
 * The provider wizard, opened where a refused External llama.cpp save
 * points: at the OpenAI-compatible route for the URL that answered the
 * probe. Users keep aiming the External pane at Ollama (:11434); since
 * the `openai-compat` verdict became visible the refusal at least said
 * why, but acting on it still meant retyping the URL into a wizard four
 * screens away. This builds the exact state picking the row by hand
 * would have built — Ollama's URL lands on its preset (entry id, env
 * var, no key screen: `ollama serve` has no key), any other compat
 * server on the manual row — with the probed URL prefilled.
 */
export function wizardForOpenAiCompatUrl(url: string): ProvidersWizardState {
  if (looksLikeOllamaUrl(url)) {
    // Mirrors Enter on the "Ollama (local)" pick_kind row, except the
    // base URL is the one the operator actually probed — a remote
    // Ollama on 192.168.x.x:11434 keeps its host.
    return {
      ...createProvidersWizardState("add"),
      kind: "openai-compatible",
      presetId: "ollama",
      baseUrlLine: url,
      phase: presetNeedsKeyScreen("ollama") ? "api_key" : "chat_model_line",
    };
  }
  // Manual compat row with the URL already filled in: Enter confirms it
  // and walks the normal URL → key → model flow (a loopback URL makes
  // the key optional, same as typing it by hand).
  return {
    ...createProvidersWizardState("add"),
    kind: "openai-compatible",
    baseUrlLine: url,
    phase: "base_url",
  };
}
