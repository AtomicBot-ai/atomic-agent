import { getConfig, type AtomicAgentConfig } from "../../config/index.js";
import type { EngineWaitVerdicts } from "../../agent/agent-contract.js";
import type { LlmFailureContext, LlmPromptBudget, LlmTruncationCounts } from "../../error-reporting/index.js";
import type { BuiltPrompt } from "../../prompt/build-prompt-types.js";
import { managedPortsOf } from "../../llm/describe-llama-health-failure.js";
import { readErrnoCode } from "../../llm/errno-code.js";
import { readFailingLink } from "../../llm/fallback/index.js";
import { findLocalPortTaken } from "../../llm/reliability/local-port-taken.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import {
  classifyLocalFault,
  explainManagedEngineLiveness,
  readChatDaemonPidState,
  readEngineExitReason,
  readLogTail,
  resolveLogFilePath,
  type ChatDaemonPidState,
  type EngineExitReason,
  type LocalFaultTag,
  type ManagedEngineLiveness,
  type ManagedEngineLivenessReport,
} from "../../local-llm/index.js";
import { resolveTurnLocalEngine } from "./runtime-turn-service.js";

export interface LlmFailureContextDeps {
  readConfig: () => AtomicAgentConfig;
  readDaemonPidState: (dataDir: string) => ChatDaemonPidState;
  /**
   * The managed engine's liveness as the outage wait reads it (ATO-772).
   * Disk reads and a signal-0 probe only, nothing that waits on the
   * engine. Asked for refused connections only.
   */
  readEngineLiveness?: (dataDir: string) => ManagedEngineLiveness;
  /**
   * The same reading with the branch that decided it and the engine lock
   * as read (ATO-1275). Preferred over `readEngineLiveness` when given.
   */
  explainEngineLiveness?: (dataDir: string) => ManagedEngineLivenessReport;
  /**
   * The managed engine's fault in its current run, as a fixed word read
   * from its log (ATO-1279). The log text stays on the machine. Absent
   * means no `localFault` is reported.
   */
  readLocalFault?: (dataDir: string) => LocalFaultTag;
  /**
   * Why the managed engine's process is gone, as a fixed word read from
   * its log (ATO-1435). Asked for refused connections with the engine
   * dead or never started only. Absent means no `engineExitReason`.
   */
  readEngineExitReason?: (dataDir: string) => EngineExitReason;
}

/** How much of the managed engine's log the fault tag reads. */
const LOCAL_FAULT_LOG_BYTES = 64 * 1024;

/** The current run's fault, by fixed strings, from the tail of the engine's log. */
export function readLocalFaultFromLog(dataDir: string): LocalFaultTag {
  return classifyLocalFault(readLogTail(resolveLogFilePath(dataDir), LOCAL_FAULT_LOG_BYTES).text);
}

const defaultDeps: LlmFailureContextDeps = {
  readConfig: getConfig,
  readDaemonPidState: readChatDaemonPidState,
  explainEngineLiveness: explainManagedEngineLiveness,
  readLocalFault: readLocalFaultFromLog,
  readEngineExitReason,
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
  event: { error: Error; outage?: { waitedMs: number; attempts: number; engineVerdicts?: EngineWaitVerdicts } },
  deps: LlmFailureContextDeps = defaultDeps,
  /** The failed turn's last built prompt, by part (ATO-1678). */
  promptBudget?: LlmPromptBudget,
): LlmFailureContext {
  const context: LlmFailureContext = {};
  // Counts only, read before any lookup below can return early.
  if (promptBudget !== undefined) context.promptBudget = promptBudget;
  const truncation = readTruncationCounts(event.error);
  if (truncation !== undefined) context.truncationCounts = truncation;
  if (event.outage) {
    context.outageWaitedMs = event.outage.waitedMs;
    context.outageAttempts = event.outage.attempts;
    // What the outage wait decided on, read when it decided (ATO-1432).
    const verdicts = event.outage.engineVerdicts;
    if (verdicts !== undefined) {
      context.engineWaitVerdict = verdicts.last.state;
      if (verdicts.last.reason !== undefined) context.engineWaitReason = verdicts.last.reason;
      context.engineWaitFirstVerdict = verdicts.first.state;
      if (verdicts.first.reason !== undefined) context.engineWaitFirstReason = verdicts.first.reason;
    }
  }
  // `ECONNREFUSED`: nothing listened on the port (ATO-421). The reason the
  // turn ended (`LocalEngineDownError`) keeps the refusal on its cause.
  const connectionRefused = readErrnoCode(event.error) === "ECONNREFUSED";
  if (connectionRefused) context.connectionRefused = true;
  // ATO-1277: the managed port answered 401 with our engine not running.
  if (findLocalPortTaken(event.error) !== null) context.portHeldByOther = true;
  const requestUrl = readRequestUrl(event.error);
  if (requestUrl !== undefined) context.requestUrl = requestUrl;
  let config: AtomicAgentConfig;
  try {
    config = deps.readConfig();
    if (requestUrl !== undefined) {
      context.managedPorts = managedPortsOf(config.localModels);
    }
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
  // Why the managed model failed, when its log says (out of memory, a
  // crash): without it an alive engine answering 500 or cutting a stream
  // has no cause in the report at all (ATO-1279).
  if (context.providerId === MANAGED_LOCAL_LINK && deps.readLocalFault !== undefined) {
    try {
      context.localFault = deps.readLocalFault(config.paths.localModelsDataDir);
    } catch {
      context.localFault = "unknown";
    }
  }
  if (connectionRefused && deps.explainEngineLiveness !== undefined) {
    try {
      const report = deps.explainEngineLiveness(config.paths.localModelsDataDir);
      context.engineLiveness = report.state;
      context.engineLivenessReason = report.reason;
      context.engineLock = report.lock;
    } catch {
      context.engineLiveness = "unknown";
    }
    // No model process: say why it is gone, if its log does (ATO-1435).
    if (
      (context.engineLiveness === "dead" || context.engineLiveness === "no_pid") &&
      deps.readEngineExitReason !== undefined
    ) {
      try {
        context.engineExitReason = deps.readEngineExitReason(config.paths.localModelsDataDir);
      } catch {
        context.engineExitReason = "unknown";
      }
    }
  } else if (connectionRefused && deps.readEngineLiveness !== undefined) {
    try {
      context.engineLiveness = deps.readEngineLiveness(config.paths.localModelsDataDir);
    } catch {
      context.engineLiveness = "unknown";
    }
  }
  return context;
}

/** The built-in managed local link, the only one whose log is ours to read. */
const MANAGED_LOCAL_LINK = "local-llama";

/** How far down `cause` the request URL is looked for. */
const MAX_URL_CAUSE_DEPTH = 4;

/**
 * The URL the failed request went to: `.url` on the error or on one of
 * its causes (`toLlmFailure`'s wrapper copies it off the
 * `LlamaServerError` / `OpenAiHttpError` underneath, and the cause keeps
 * it too). Raw: the error reporter reduces it to `request_route` and
 * `port_class` and sends nothing else of it (ATO-872).
 */
function readRequestUrl(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_URL_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const url = (current as { url?: unknown }).url;
    if (typeof url === "string" && url.length > 0) return url;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The budget parts of a built prompt (ATO-1678): the numbers that say
 * whether a full window was the history, the prefix, the native tool
 * schemas or the reply reserve. Counts only; no text is read.
 */
export function promptBudgetOf(prompt: BuiltPrompt): LlmPromptBudget {
  return {
    totalTokens: prompt.tokens.total,
    stablePrefixTokens: prompt.tokens.stablePrefix,
    toolSchemaTokens: prompt.tokens.toolSchema ?? 0,
    conversationTokens: prompt.tokens.conversation,
    contextWindow: prompt.contextWindow,
    replyReserve: prompt.contextBudget?.replyReserve ?? prompt.replyReserve ?? null,
  };
}

/**
 * The counts of a truncated reply (`ModelError.truncation`) on the error
 * or its causes. Only the three numbers are copied, never the message.
 */
function readTruncationCounts(error: unknown): LlmTruncationCounts | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_URL_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const detail = (current as { truncation?: unknown }).truncation;
    if (typeof detail === "object" && detail !== null) {
      const { promptTokens, completionTokens, requestedMaxTokens } = detail as Record<string, unknown>;
      if (typeof promptTokens === "number" && typeof completionTokens === "number") {
        return {
          promptTokens,
          completionTokens,
          ...(typeof requestedMaxTokens === "number" ? { requestedMaxTokens } : {}),
        };
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
