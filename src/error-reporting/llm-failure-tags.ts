import { PROVIDER_PRESETS } from "../llm/provider/presets/provider-presets.js";

/**
 * Turn-level context the runtime attaches to an `llm_failure` report: which
 * provider and local engine the turn failed on, how long it had waited out
 * an outage, and whether the managed engine's process was alive. Raw
 * values; {@link sanitizeLlmFailureTags} decides what may travel.
 */
export interface LlmFailureContext {
  providerId?: string;
  /** `LocalEngine` from analytics: `atomic-core` / `llama-server` / `external`. */
  localEngine?: string;
  outageWaitedMs?: number;
  outageAttempts?: number;
  /** `alive` / `dead` / `no_pid` / `unknown`. Dropped for `external`. */
  daemonState?: string;
}

/**
 * Built-in provider ids that are not presets (the synthesized local entry
 * and the providers the agent ships adapters for). A provider id the
 * operator typed can name a company or a machine, so only these and the
 * preset ids leave the machine; anything else reports as `unknown`.
 */
const BUILT_IN_PROVIDER_IDS = ["local-llama", "openrouter", "aimlapi", "gemini", "openai"] as const;
const KNOWN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  ...BUILT_IN_PROVIDER_IDS,
  ...PROVIDER_PRESETS.map((preset) => preset.id),
]);
const LOCAL_ENGINES: ReadonlySet<string> = new Set(["atomic-core", "llama-server", "external"]);
const DAEMON_STATES: ReadonlySet<string> = new Set(["alive", "dead", "no_pid", "unknown"]);

const UNKNOWN = "unknown";

function fromVocabulary(value: string, vocabulary: ReadonlySet<string>): string {
  return vocabulary.has(value) ? value : UNKNOWN;
}

function safeCount(value: number): string {
  return Number.isFinite(value) && value >= 0 ? String(Math.round(value)) : UNKNOWN;
}

/**
 * Sentry tags for an {@link LlmFailureContext}. Only fixed words and
 * non-negative integers come out: a value outside its vocabulary becomes
 * `unknown`, never the value itself, so no path, address, port or error
 * text can ride along. `daemon_state` is left out for an `external`
 * engine, whose process is the operator's and not ours to inspect.
 */
export function sanitizeLlmFailureTags(
  context: LlmFailureContext | undefined,
): Record<string, string> | undefined {
  if (context === undefined) return undefined;
  const tags: Record<string, string> = {};
  if (context.providerId !== undefined) {
    tags.provider_id = fromVocabulary(context.providerId, KNOWN_PROVIDER_IDS);
  }
  if (context.localEngine !== undefined) {
    tags.local_engine = fromVocabulary(context.localEngine, LOCAL_ENGINES);
  }
  if (context.outageWaitedMs !== undefined) {
    tags.outage_waited_ms = safeCount(context.outageWaitedMs);
  }
  if (context.outageAttempts !== undefined) {
    tags.outage_attempts = safeCount(context.outageAttempts);
  }
  if (context.daemonState !== undefined && tags.local_engine !== "external") {
    tags.daemon_state = fromVocabulary(context.daemonState, DAEMON_STATES);
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}
