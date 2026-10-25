import type { AtomicAgentConfig } from "../../config/index.js";
import {
  decideContextGrowth,
  readLaunchRecord,
  readRunningPid,
  type LaunchRecord,
} from "../../local-llm/index.js";
import { effectiveReplyReserve } from "../../prompt/token-budget.js";

/** One growth step the daemon's owner should take before the next turn. */
export interface LocalContextGrowthStep {
  modelId: string;
  from: number;
  to: number;
  promptTokens: number;
}

/**
 * Whether the managed chat daemon should be restarted with a bigger
 * window before the next turn of a conversation whose last prompt held
 * `promptTokens` (`session.contextUsage.tokens`, the server's own count).
 *
 * Only the auto window grows (`localModels.managed.contextSize: 0`), and
 * only a launch that recorded a ceiling — the growing window on a GPU
 * with memory of its own (`context-growth.ts`); everything else answers
 * `null`. The launch record belongs to the live pid, so a daemon that is
 * down or was started by an older build is never grown.
 */
export function planLocalContextGrowth(
  cfg: Pick<AtomicAgentConfig, "localModels" | "paths">,
  promptTokens: number | null | undefined,
  readRecord: (dataDir: string) => LaunchRecord | null = (dataDir) =>
    readLaunchRecord(dataDir, readRunningPid(dataDir)),
): LocalContextGrowthStep | null {
  if (cfg.localModels.mode !== "managed") return null;
  if (cfg.localModels.managed.contextSize > 0) return null;
  if (typeof promptTokens !== "number" || !(promptTokens > 0)) return null;
  const record = readRecord(cfg.paths.localModelsDataDir);
  if (!record || record.modelId !== cfg.localModels.managed.modelId) return null;
  const to = decideContextGrowth({
    currentContext: record.contextSize,
    ceiling: record.autoContextCeiling ?? null,
    promptTokens,
    replyReserveTokens: effectiveReplyReserve(
      cfg.localModels.completionMaxTokens,
      record.contextSize,
    ),
  });
  return to === null
    ? null
    : { modelId: record.modelId, from: record.contextSize, to, promptTokens };
}

/** What `growLocalContext` needs from the daemon's owner. */
export interface LocalContextGrowthDeps {
  /** The step to take, if any (`planLocalContextGrowth`). */
  plan(): LocalContextGrowthStep | null;
  /** The window the next start asks for (`null`: the committed one). */
  setAttempt(atLeast: number | null): void;
  /** The grown window stands: later starts of this model begin there. */
  commit(step: LocalContextGrowthStep): void;
  /** Restart the chat daemon (stop, then a start that reads the attempt). */
  restart(): Promise<boolean>;
  /**
   * Start again at the committed window after a failed growth: adopts a
   * daemon that is still up, or brings one back so the turn has a server.
   */
  startAgain(): Promise<boolean>;
  emit(line: string): void;
}

/**
 * One growth step: restart with the bigger window, and only once that
 * start came up record it as the model's window. A bigger start that
 * fails is not remembered — the next start goes back to the window that
 * worked, and is made now, so the turn about to be sent has a server.
 */
export async function growLocalContext(deps: LocalContextGrowthDeps): Promise<boolean> {
  const step = deps.plan();
  if (!step) return false;
  deps.emit(
    `local-llm: the conversation fills the ${step.from}-token window ` +
      `(${step.promptTokens} tokens in the last prompt) — restarting the model with ${step.to}`,
  );
  deps.setAttempt(step.to);
  let grown = false;
  try {
    grown = await deps.restart();
  } catch {
    grown = false;
  } finally {
    deps.setAttempt(null);
  }
  if (grown) {
    deps.commit(step);
    return true;
  }
  deps.emit(
    `local-llm: the model did not come back with ${step.to} tokens — starting it again with ${step.from}`,
  );
  try {
    await deps.startAgain();
  } catch {
    /* the turn reports a missing server itself */
  }
  return false;
}
