import {
  nativeToolReplyLooksMalformed,
  toolCallModeAfterProbe,
  type NativeToolReplyObservation,
} from "../verify/tool-call-mode.js";
import type { ProviderContractStatus } from "../verify/contract-probe-types.js";
import { isLocalServerUrl } from "./local-server-url.js";

/**
 * Which (provider id, model) pairs send their tool calls through a JSON
 * reply instead of `tools` (ATO-642), for the lifetime of the process.
 *
 * Native tools stay the default for every model: a pair moves over only
 * on evidence that the engine's tool-call parser fails it, either a
 * contract probe verdict (`applyProbeVerdict`) or native replies that
 * come back malformed `MALFORMED_STRIKES` times in a row with no clean
 * call between them (`noteNativeReply`). A pair moves back, for good,
 * when the engine refuses `response_format` itself (`markRefused`).
 *
 * Process-wide and not persisted, like `structuredOutputRefusals`: a
 * provider is rebuilt on every config write, and forgetting there would
 * replay the failing native turns after each save; a restart is the
 * cheapest re-probe of an engine that was updated meanwhile.
 */
export const MALFORMED_STRIKES = 2;

type PairState = { strikes: number; mode: "native" | "json_schema" | "refused" };

export class JsonSchemaToolModes {
  private readonly pairs = new Map<string, PairState>();

  /** Whether this pair's tool calls go out as a JSON reply. */
  isOn(providerId: string, model: string): boolean {
    return this.pairs.get(pairKey(providerId, model))?.mode === "json_schema";
  }

  /**
   * Record a native-tools reply. `true` only on the reply that switches
   * the pair over, which is when to log.
   */
  noteNativeReply(
    providerId: string,
    model: string,
    reply: NativeToolReplyObservation,
  ): boolean {
    const state = this.stateOf(providerId, model);
    if (state.mode !== "native") return false;
    if (!nativeToolReplyLooksMalformed(reply)) {
      // A clean call proves the parser knows this model; a plain answer
      // proves nothing either way and leaves the count alone.
      if ((reply.toolCalls?.length ?? 0) > 0) state.strikes = 0;
      return false;
    }
    state.strikes += 1;
    if (state.strikes < MALFORMED_STRIKES) return false;
    state.mode = "json_schema";
    return true;
  }

  /**
   * Apply a contract probe verdict for the pair. A verdict about tool
   * calling sets the mode either way; any other verdict changes nothing.
   * A pair whose engine refused `response_format` is never moved back.
   */
  applyProbeVerdict(
    providerId: string,
    model: string,
    status: ProviderContractStatus,
  ): void {
    const mode = toolCallModeAfterProbe(status);
    const state = this.stateOf(providerId, model);
    if (mode === null || state.mode === "refused") return;
    state.mode = mode === "json_schema" ? "json_schema" : "native";
    state.strikes = 0;
  }

  /**
   * The engine refused `response_format`: native tools for this pair for
   * the rest of the process. `true` the first time, which is when to log.
   */
  markRefused(providerId: string, model: string): boolean {
    const state = this.stateOf(providerId, model);
    if (state.mode === "refused") return false;
    state.mode = "refused";
    return true;
  }

  private stateOf(providerId: string, model: string): PairState {
    const key = pairKey(providerId, model);
    let state = this.pairs.get(key);
    if (!state) {
      state = { strikes: 0, mode: "native" };
      this.pairs.set(key, state);
    }
    return state;
  }
}

/** The process-wide record every `OpenAiProvider` consults. */
export const jsonSchemaToolModes = new JsonSchemaToolModes();

function pairKey(providerId: string, model: string): string {
  return JSON.stringify([providerId, model]);
}

/**
 * Whether a provider entry is an external local engine the JSON-reply
 * fallback is for: the Ollama or LM Studio preset, or a server on this
 * machine or network at their default ports (11434, 1234). Ollama Cloud
 * and other hosted services are not: their tool parsing is the vendor's
 * job, and they keep native tools whatever comes back.
 */
export function isExternalEngineEntry(entry: {
  id: string;
  baseUrl?: string | undefined;
}): boolean {
  if (!entry.baseUrl || !isLocalServerUrl(entry.baseUrl)) return false;
  if (entry.id === "ollama" || entry.id === "lmstudio") return true;
  let port: string;
  try {
    port = new URL(entry.baseUrl).port;
  } catch {
    return false;
  }
  return port === "11434" || port === "1234";
}
