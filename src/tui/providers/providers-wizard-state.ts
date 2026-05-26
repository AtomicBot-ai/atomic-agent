export type ProvidersWizardKind = "openrouter" | "openai-compatible";

export type ProvidersWizardPhase =
  | "pick_kind"
  | "api_key"
  | "pick_chat_model"
  | "pick_embedding"
  | "base_url"
  | "chat_model_line"
  | "embedding_model_line";

export type ProvidersWizardMode = "add" | "configure";

export interface ProvidersWizardState {
  mode: ProvidersWizardMode;
  phase: ProvidersWizardPhase;
  kind: ProvidersWizardKind | null;
  /** Set when `mode === "configure"`. */
  providerId: string | null;
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
  opts?: { providerId?: string; kind?: ProvidersWizardKind },
): ProvidersWizardState {
  const configure = mode === "configure";
  const kind = opts?.kind ?? null;
  return {
    mode,
    phase: configure ? "api_key" : "pick_kind",
    kind,
    providerId: opts?.providerId ?? null,
    cursor: 0,
    apiKeyBuffer: "",
    baseUrlLine: "",
    chatModelLine: "",
    embeddingModelLine: "",
    selectedChatModelId: null,
    selectedEmbeddingChoiceId: null,
    error: null,
    submitting: false,
  };
}
