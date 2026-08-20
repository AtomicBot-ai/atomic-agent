import type { SubscriptionCliName } from "../../config/llm-config.js";
import { presetForEntryId } from "./provider-presets.js";

export type ProvidersWizardKind =
  | "claude-cli"
  | "codex-cli"
  | "openrouter"
  | "aimlapi"
  | "gemini"
  | "openai-compatible";

/**
 * Wizard rows that map onto the single `subscription-cli` config kind.
 * One row per vendor CLI keeps the choice on the screen the operator is
 * already looking at, instead of adding a wizard phase whose only job is
 * to ask "which CLI?".
 */
const SUBSCRIPTION_CLI_WIZARD_KINDS: Partial<
  Record<ProvidersWizardKind, SubscriptionCliName>
> = {
  "claude-cli": "claude",
  "codex-cli": "codex",
};

/** The vendor CLI this row drives, or null for a key-based provider. */
export function subscriptionCliForWizardKind(
  kind: ProvidersWizardKind,
): SubscriptionCliName | null {
  return SUBSCRIPTION_CLI_WIZARD_KINDS[kind] ?? null;
}

/**
 * The wizard row a stored `subscription-cli` entry came from. The map
 * above only runs one way, and a saved entry keeps the CLI name rather
 * than the row it was picked on, so reconfiguring one has to walk back.
 * `null` for a CLI name no wizard row offers.
 */
export function wizardKindForSubscriptionCli(
  cli: string,
): ProvidersWizardKind | null {
  for (const [kind, name] of Object.entries(SUBSCRIPTION_CLI_WIZARD_KINDS)) {
    if (name === cli) return kind as ProvidersWizardKind;
  }
  return null;
}

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
    /**
     * Stored chat model of the entry being reconfigured. Prefills the
     * model step so Enter keeps the pinned model instead of silently
     * resetting it to the kind's default.
     */
    chatModel?: string;
  },
): ProvidersWizardState {
  const configure = mode === "configure";
  const kind = opts?.kind ?? null;
  // A CLI-backed provider has no key to paste — it authenticates from
  // the CLI's own session. Opening configure on the key screen would be
  // the dead end `advanceWizardPhase` already skips on the add path, so
  // reconfiguring lands on the one thing that is editable: the model.
  const cliBacked = kind !== null && subscriptionCliForWizardKind(kind) !== null;
  const phase: ProvidersWizardPhase = !configure
    ? "pick_kind"
    : cliBacked
      ? "chat_model_line"
      : "api_key";
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
    phase,
    kind,
    providerId: opts?.providerId ?? null,
    presetId,
    cursor: 0,
    apiKeyBuffer: "",
    baseUrlLine: opts?.baseUrl ?? "",
    chatModelLine: cliBacked ? (opts?.chatModel ?? "") : "",
    embeddingModelLine: "",
    selectedChatModelId: null,
    selectedEmbeddingChoiceId: null,
    error: null,
    submitting: false,
  };
}
