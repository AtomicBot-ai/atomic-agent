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
  /**
   * The URL the failed request went to (`LlamaServerError.url` /
   * `OpenAiHttpError.url`). Never sent: only its route and port class
   * leave as fixed words (`request_route`, `port_class`).
   */
  requestUrl?: string;
  /** The agent's own engine ports, so `port_class` can say `managed`. */
  managedPorts?: readonly number[];
  /**
   * The failed request was refused (`ECONNREFUSED` on the error or its
   * causes): nothing listened on the model's port (ATO-421). Only then are
   * `local_engine_alive` and `refused_wait_ms` sent, and `local_engine`
   * is sent as `unknown` when the link is not a local engine we know.
   */
  connectionRefused?: boolean;
  /**
   * The managed engine's process as the outage wait judges it
   * (`readManagedEngineLiveness`): `alive` / `dead` / `no_pid` / `unknown`,
   * where `unknown` includes a start, load or install under way.
   * Probed for refusals on the managed engine only.
   */
  engineLiveness?: string;
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
const ENGINE_ALIVE: ReadonlyMap<string, LocalEngineAlive> = new Map([
  ["alive", "yes"],
  ["dead", "no"],
  ["no_pid", "no"],
]);

/** Whether the managed engine's process was running when a refusal was reported. */
export type LocalEngineAlive = "yes" | "no" | "unknown";

/**
 * How long a refused turn had waited, as a fixed bucket. The edges are the
 * ones the turn loop acts on: the 8 s restart grace after which a dead
 * managed engine ends the turn (`local_engine_down`, ATO-772), and the
 * default five-minute outage budget.
 */
export type RefusedWaitBucket = "0" | "under_8s" | "8s_to_30s" | "30s_to_2m" | "2m_to_5m" | "5m_plus";

const UNKNOWN = "unknown";

function fromVocabulary(value: string, vocabulary: ReadonlySet<string>): string {
  return vocabulary.has(value) ? value : UNKNOWN;
}

/** Which endpoint the failed request hit, as a fixed word (ATO-872). */
export type RequestRoute = "chat_completions" | "completion" | "other";

/**
 * Who usually listens on the failed request's port, as a fixed word:
 * our managed engine, llama.cpp's old default 8080, the 9931 default,
 * Atomic Chat on 1337, Ollama on 11434, or `other`.
 */
export type PortClass =
  | "managed"
  | "legacy_8080"
  | "default_9931"
  | "atomic_chat_1337"
  | "ollama_11434"
  | "other";

const WELL_KNOWN_PORTS: ReadonlyMap<string, PortClass> = new Map([
  ["8080", "legacy_8080"],
  ["9931", "default_9931"],
  ["1337", "atomic_chat_1337"],
  ["11434", "ollama_11434"],
]);

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * `chat_completions` for `/chat/completions` (OpenAI shape and
 * llama-server's `/v1/chat/completions`), `completion` for llama-server's
 * native `/completion` and the legacy `/completions`, `other` for any
 * other path. Only the last path segments are read; the path itself
 * never leaves this function.
 */
export function classifyRequestRoute(url: string): RequestRoute | "unknown" {
  const parsed = parseUrl(url);
  if (parsed === null) return UNKNOWN;
  const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
  if (path.endsWith("/chat/completions")) return "chat_completions";
  if (path.endsWith("/completion") || path.endsWith("/completions")) return "completion";
  return "other";
}

/**
 * The port class for `url`. A managed engine port wins over the
 * well-known numbers (an operator can put the managed engine on 8080).
 * A URL with no explicit port is `other`.
 */
export function classifyPortClass(
  url: string,
  managedPorts: readonly number[] = [],
): PortClass | "unknown" {
  const parsed = parseUrl(url);
  if (parsed === null) return UNKNOWN;
  if (parsed.port === "") return "other";
  if (managedPorts.some((port) => String(port) === parsed.port)) return "managed";
  return WELL_KNOWN_PORTS.get(parsed.port) ?? "other";
}

/** The bucket for a refused turn's outage wait; `unknown` for a value that is not a count. */
export function bucketRefusedWait(waitedMs: number): RefusedWaitBucket | "unknown" {
  if (!Number.isFinite(waitedMs) || waitedMs < 0) return UNKNOWN;
  if (waitedMs === 0) return "0";
  if (waitedMs < 8_000) return "under_8s";
  if (waitedMs < 30_000) return "8s_to_30s";
  if (waitedMs < 120_000) return "30s_to_2m";
  if (waitedMs < 300_000) return "2m_to_5m";
  return "5m_plus";
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
 * `request_route` and `port_class` are derived from the request URL;
 * the URL, its host and its port number are never tags themselves.
 * A refused connection adds `local_engine_alive` (`yes` / `no` /
 * `unknown`) and `refused_wait_ms` (a fixed bucket), so the ATO-421
 * clusters split into "crashed", "never started" and "external" (ATO-769).
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
  if (context.requestUrl !== undefined) {
    tags.request_route = classifyRequestRoute(context.requestUrl);
    tags.port_class = classifyPortClass(context.requestUrl, context.managedPorts);
  }
  if (context.connectionRefused === true) {
    tags.local_engine ??= UNKNOWN;
    // An external server is the operator's process: we never look at it.
    tags.local_engine_alive =
      tags.local_engine === "external" || context.engineLiveness === undefined
        ? UNKNOWN
        : (ENGINE_ALIVE.get(context.engineLiveness) ?? UNKNOWN);
    tags.refused_wait_ms = bucketRefusedWait(context.outageWaitedMs ?? 0);
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}
