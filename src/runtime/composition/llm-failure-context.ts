import { getConfig, type AtomicAgentConfig } from "../../config/index.js";
import type { LlmFailureContext } from "../../error-reporting/index.js";
import { readFailingLink } from "../../llm/fallback/index.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import { readChatDaemonPidState, type ChatDaemonPidState } from "../../local-llm/index.js";
import { resolveTurnLocalEngine } from "./runtime-turn-service.js";

export interface LlmFailureContextDeps {
  readConfig: () => AtomicAgentConfig;
  readDaemonPidState: (dataDir: string) => ChatDaemonPidState;
}

const defaultDeps: LlmFailureContextDeps = {
  readConfig: getConfig,
  readDaemonPidState: readChatDaemonPidState,
};

/**
 * What an `llm_failure` report says about the failed turn beyond the
 * error itself: the provider it failed on (the link that threw, else the
 * configured active one), which local engine served it, the outage wait
 * it had spent, and for the managed engine whether its process was alive.
 * Without these "never started", "crashed" and "wrong port" all look the
 * same in Sentry. Raw values: the error reporter keeps only fixed words.
 *
 * Never throws. A report without the engine context is worth more than
 * no report, so a failed lookup leaves the field out (or, for the
 * process probe, says `unknown`).
 */
export function describeLlmFailure(
  event: { error: Error; outage?: { waitedMs: number; attempts: number } },
  deps: LlmFailureContextDeps = defaultDeps,
): LlmFailureContext {
  const context: LlmFailureContext = {};
  if (event.outage) {
    context.outageWaitedMs = event.outage.waitedMs;
    context.outageAttempts = event.outage.attempts;
  }
  let config: AtomicAgentConfig;
  try {
    config = deps.readConfig();
    context.providerId = readFailingLink(event.error) ?? resolveLlmConfig(config).activeTextProvider;
    const localEngine = resolveTurnLocalEngine(config, context.providerId);
    if (localEngine === undefined) return context;
    context.localEngine = localEngine;
    if (localEngine === "external") return context;
  } catch {
    return context;
  }
  try {
    context.daemonState = deps.readDaemonPidState(config.paths.localModelsDataDir);
  } catch {
    context.daemonState = "unknown";
  }
  return context;
}
