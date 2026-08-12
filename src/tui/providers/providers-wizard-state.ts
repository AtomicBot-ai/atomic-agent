import { presetForEntryId } from "./provider-presets.js";

export type ProvidersWizardKind =
  | "openrouter"
  | "aimlapi"
  | "gemini"
  | "openai-compatible";

export type ProvidersWizardPhase =
  | "pick_kind"
  | "api_key"
  | "pick_chat_model"
  | "pick_embedding"
  | "base_url"
  | "chat_model_line";

export type ProvidersWizardMode = "add" | "configure";

export interface ProvidersWizardState {
  mode: ProvidersWizardMode;
  phase: ProvidersWizardPhase;
  kind: ProvidersWizardKind | null;
  /** Set when `mode === "configure"`. */
  providerId: string | null;
  /**
   * Preset chosen on the `pick_preset` step. Presets are not a provider
   * kind: they resolve to `openai-compatible` with `baseUrl` prefilled,
   * so the operator never types an endpoint from memory (#69).
   */
  presetId: string | null;
  cursor: number;
  apiKeyBuffer: string;
  baseUrlLine: string;
  chatModelLine: string;
  embeddingModelLine: string;
  /** Filled when the operator confirms an OpenRouter chat row. */
  selectedChatModelId: string | null;
  /** Filled when the operator confirms an embedding row. */
  selectedEmbeddingChoiceId: string | null;
  error: string | null;
  submitting: boolean;
}

export function createProvidersWizardState(
  mode: ProvidersWizardMode,
  opts?: {
    providerId?: string;
    kind?: ProvidersWizardKind;
    /**
     * Stored base URL of the entry being reconfigured. Prefills the
     * `base_url` step so pressing Enter through it keeps the custom
     * endpoint instead of silently resetting it to the OpenAI default.
     */
    baseUrl?: string;
  },
): ProvidersWizardState {
  const configure = mode === "configure";
  const kind = opts?.kind ?? null;
  // Reconfiguring an entry that was created from a preset must keep the
  // preset identity: the key screen then names the service's own env
  // var, and saving keeps the entry id instead of minting an
  // `openai-compatible` duplicate. Suffixed ids (`groq-2`) count too.
  const presetId =
    configure && kind === "openai-compatible" && opts?.providerId
      ? (presetForEntryId(opts.providerId)?.id ?? null)
      : null;
  return {
    mode,
    phase: configure ? "api_key" : "pick_kind",
    kind,
    providerId: opts?.providerId ?? null,
    presetId,
    cursor: 0,
    apiKeyBuffer: "",
    baseUrlLine: opts?.baseUrl ?? "",
    chatModelLine: "",
    embeddingModelLine: "",
    selectedChatModelId: null,
    selectedEmbeddingChoiceId: null,
    error: null,
    submitting: false,
  };
}
