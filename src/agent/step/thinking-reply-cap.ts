import type { ModelProfile } from "../../llm/model-profile.js";
import { createLocalModelsDefaults } from "../../config/local-models/local-models-defaults.js";

/**
 * The reply cap a local thinking model gets when nobody chose one (ATO-1031).
 *
 * A grammar-served reasoning model (`qwen-think`, `gemma4-think`) spends
 * its think block out of the same `n_predict` as its answer. The shipped
 * cap, `localModels.completionMaxTokens` = 16,384, is sized for an
 * answer, and a long think block ate it before the reply started: the
 * turn ended cut at the limit with nothing to show.
 *
 * So a thinking profile on a local grammar link runs under
 * `THINKING_REPLY_CAP` instead — only while the cap is the untouched
 * default. A cap the operator wrote into the config, or set through
 * `ATOMIC_AGENT_LLAMA_MAX_TOKENS` (which wins over the file, ATO-922), is
 * theirs and stays. A step that already carries its own cap (a
 * truncation retry, a fusion worker's ceiling) keeps it too.
 *
 * The cap bounds a runaway reply, not memory: llama.cpp commits the
 * context at launch, and a reply that outgrows the window stops at the
 * window. Where the window is known the lift stays inside it.
 */
export const THINKING_REPLY_CAP = 32_768;

/** The env override of the local reply cap (ATO-922): when set, the operator chose. */
export const LOCAL_REPLY_CAP_ENV = "ATOMIC_AGENT_LLAMA_MAX_TOKENS";

/** Room kept between a lifted cap and a known window, for token-estimate drift. */
const WINDOW_HEADROOM_TOKENS = 512;

export interface ThinkingReplyCapInput {
  profile: ModelProfile;
  /** `localModels.thinking: "off"` reached this request (prompt marker or template switch). */
  thinkingDisabled: boolean;
  /** The step's model mode; legacy wiring without one reads as `local`. */
  modelMode: "local" | "cloud";
  /** The step's configured transport. Only a grammar link is a local llama-server. */
  toolTransport: "grammar" | "native_tools";
  /** `localModels.completionMaxTokens` as resolved (env included). */
  configuredCap: number;
  /** The step carries its own cap (`maxTokens` / `maxOutputTokens`). */
  stepCapSet: boolean;
  /** `ATOMIC_AGENT_LLAMA_MAX_TOKENS` is set. */
  envCapSet: boolean;
  /** The window the runtime believes in, when it knows one. */
  contextWindow: number | null;
  /** The prompt's token estimate. */
  promptTokens: number;
}

/** The shipped `localModels.completionMaxTokens`. */
export function defaultLocalReplyCap(): number {
  return createLocalModelsDefaults().completionMaxTokens;
}

/** Whether the env override of the local reply cap is set. */
export function localReplyCapEnvSet(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (env[LOCAL_REPLY_CAP_ENV] ?? "").trim().length > 0;
}

/**
 * The lifted cap for this step, or `null` when the step keeps the
 * configured one.
 */
export function thinkingReplyCap(input: ThinkingReplyCapInput): number | null {
  if (input.stepCapSet || input.envCapSet) return null;
  if (input.modelMode === "cloud") return null;
  if (input.toolTransport !== "grammar") return null;
  if (input.profile.reasoningStyle === "none" || input.thinkingDisabled) {
    return null;
  }
  // `0` is "no cap" already; any other value than the default was chosen.
  if (input.configuredCap <= 0) return null;
  if (input.configuredCap !== defaultLocalReplyCap()) return null;
  const room =
    input.contextWindow !== null &&
    input.contextWindow > 0 &&
    input.promptTokens > 0
      ? input.contextWindow - input.promptTokens - WINDOW_HEADROOM_TOKENS
      : Number.POSITIVE_INFINITY;
  const lifted = Math.floor(Math.min(THINKING_REPLY_CAP, room));
  return lifted > input.configuredCap ? lifted : null;
}
