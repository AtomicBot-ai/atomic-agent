/**
 * Shapes for the pre-save credential check: what to probe, and what the
 * probe concluded. Kept free of config and UI imports so the check can
 * run from the wizard, from onboarding, or from a future "test key"
 * action without dragging any of them along.
 */

/** The cloud kinds a key can be checked for. Local servers never carry one. */
export type ProviderVerifyKind =
  | "openrouter"
  | "aimlapi"
  | "gemini"
  | "openai-compatible";

export type ProviderVerifyStatus =
  /** The provider answered a real completion: the key is live and funded. */
  | "ok"
  /** The provider does not recognize this key, or refuses it outright. */
  | "invalid_key"
  /** The key authenticates but the account cannot pay for a token. */
  | "no_balance"
  /** None of the probe models exist for this key; auth stays unproven. */
  | "model_unavailable"
  /** Throttled right now — which itself proves the key authenticated. */
  | "rate_limited"
  /** No HTTP response at all: DNS, refused connection, TLS, offline. */
  | "unreachable"
  /** Our own deadline fired before the provider answered. */
  | "timeout"
  /** The provider failed in a way that says nothing about the key. */
  | "provider_error"
  /** The operator (or the caller) aborted the check. */
  | "cancelled";

export interface ProviderVerifyTarget {
  /** Service name for user-facing wording ("OpenRouter", "Groq"). */
  readonly label: string;
  /** API root without the version prefix, already normalized. */
  readonly baseUrl: string;
  /** Version prefix the service uses: `/v1`, Gemini's `/v1beta/openai`. */
  readonly apiPathPrefix: string;
  /** Trimmed key. A target is never built without one. */
  readonly apiKey: string;
  /** Ordered candidates; at most the first two are tried. */
  readonly probeModels: readonly string[];
  readonly extraHeaders?: Record<string, string>;
}

export interface ProviderVerifyResult {
  readonly status: ProviderVerifyStatus;
  /** The model the verdict came from, `null` when nothing was answered. */
  readonly probedModel: string | null;
  readonly httpStatus: number | null;
  /** Bounded provider text for the status line and logs; never the key. */
  readonly detail: string;
  readonly latencyMs: number;
}

/**
 * The two verdicts that must stop a save. Everything else is a report:
 * a machine behind a proxy, an offline laptop or a throttled key still
 * has to be configurable, and refusing there would strand the operator
 * with no way to enter a key at all.
 */
export function isBlockingVerifyStatus(status: ProviderVerifyStatus): boolean {
  return status === "invalid_key" || status === "no_balance";
}
