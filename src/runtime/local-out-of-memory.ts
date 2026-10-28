import type { AtomicAgentConfig } from "../config/index.js";
import type { ApprovalGate } from "../approval/index.js";
import type {
  LocalOutOfMemoryChoice,
  LocalOutOfMemoryPort,
} from "../agent/agent-contract.js";
import {
  describeServerFault,
  readLaunchRecord,
  readLogTail,
  readRunningPid,
  resolveLogFilePath,
} from "../local-llm/index.js";

/** The built-in managed local link (`LlamaServerProvider`'s default id). */
const MANAGED_LOCAL_LINK = "local-llama";

/**
 * The answer a person gives to "pick a smaller model" on a surface whose
 * approval card has only Allow and Deny: a Deny carrying this reason.
 */
export const PICK_SMALLER_MODEL_REASON = "pick_smaller_model";

/** The tool name the out-of-memory question carries on the approval surface. */
export const LOCAL_MODEL_RESTART_TOOL = "local_model.restart";

/**
 * Restart the managed model with `contextWindow` for this run only. The
 * process that owns the model registers one (the TUI); a headless
 * `serve` has none, because the desktop owns the model there.
 */
export type LocalModelRestarter = (
  contextWindow: number,
  signal: AbortSignal,
) => Promise<boolean>;

export interface LocalOutOfMemoryReaders {
  /** The tail of the managed server's log. */
  readLog: (dataDir: string) => string;
  /** The `--ctx-size` the running model was launched with, or `null`. */
  launchContextSize: (dataDir: string) => number | null;
}

const fileReaders: LocalOutOfMemoryReaders = {
  readLog: (dataDir) => readLogTail(resolveLogFilePath(dataDir)).text,
  launchContextSize: (dataDir) =>
    readLaunchRecord(dataDir, readRunningPid(dataDir))?.contextSize ?? null,
};

/**
 * Did the managed local model behind `providerId` run out of memory in
 * its current run (ATO-334)? The window that run was started with when it
 * did (`0` when the launch record does not say), else `null`.
 *
 * Judged only for the built-in `local-llama` link in managed mode: an
 * external server is the operator's to run, and a cloud link is not a
 * process on this machine. An error that does not name its link is the
 * active provider's. Only the current run's log counts
 * (`describeServerFault` scopes to the last launch marker), so a restart
 * clears the verdict.
 */
export function readLocalOutOfMemory(
  providerId: string | undefined,
  cfg: Pick<AtomicAgentConfig, "localModels" | "paths">,
  activeTextProvider: string,
  readers: LocalOutOfMemoryReaders = fileReaders,
): { contextWindow: number } | null {
  if ((providerId ?? activeTextProvider) !== MANAGED_LOCAL_LINK) return null;
  if (cfg.localModels.mode !== "managed") return null;
  const dataDir = cfg.paths.localModelsDataDir;
  try {
    const fault = describeServerFault(readers.readLog(dataDir));
    if (fault?.kind !== "out_of_memory") return null;
    const window = readers.launchContextSize(dataDir);
    return { contextWindow: window !== null && window > 0 ? window : 0 };
  } catch {
    return null;
  }
}

export interface LocalOutOfMemoryPortDeps {
  readConfig: () => Pick<AtomicAgentConfig, "localModels" | "paths">;
  activeTextProvider: () => string;
  approvals: Pick<ApprovalGate, "request">;
  /** The restarter registered right now, or `null`. */
  restarter: () => LocalModelRestarter | null;
  readers?: LocalOutOfMemoryReaders;
}

/**
 * The runtime's `localOutOfMemory` port. The question goes out through
 * the approval gate, the surface every host already draws and answers
 * (the TUI's prompt, the desktop's card over `/api/events` and
 * `POST /api/approval/resolve`): Allow restarts with the smaller window,
 * Deny stops, and a Deny whose reason is `pick_smaller_model` stops so
 * the person can pick another model. A denial nobody made (a session
 * that refuses prompts) means nobody is there to ask, so the window is
 * halved as for any unattended turn.
 */
export function createLocalOutOfMemoryPort(deps: LocalOutOfMemoryPortDeps): LocalOutOfMemoryPort {
  return {
    detect: (providerId) =>
      readLocalOutOfMemory(providerId, deps.readConfig(), deps.activeTextProvider(), deps.readers),
    canRestart: () => deps.restarter() !== null,
    ask: async (question, signal): Promise<LocalOutOfMemoryChoice> => {
      const decision = await deps.approvals.request(
        {
          approvalId: question.questionId,
          sessionId: question.sessionId,
          tool: LOCAL_MODEL_RESTART_TOOL,
          category: "local_model_restart",
          reason: question.message,
          preview:
            `Allow: restart with a smaller window (${question.nextContextWindow} tokens). ` +
            "Deny: stop, to pick a smaller model or leave it.",
        },
        { signal },
      );
      if (decision.approved) return "restart_smaller";
      if (decision.automatic === true && decision.declinedEarlier !== true) return "restart_smaller";
      return decision.reason?.trim() === PICK_SMALLER_MODEL_REASON ? "pick_smaller_model" : "cancel";
    },
    restart: async (contextWindow, signal) => {
      const restarter = deps.restarter();
      if (restarter === null) return false;
      return await restarter(contextWindow, signal);
    },
  };
}
