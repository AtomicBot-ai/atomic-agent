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
