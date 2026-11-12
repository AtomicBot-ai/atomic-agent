import type { ContextUsageState } from "../session/context-usage.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import type { SessionState } from "../session/session-state.js";
import type { CompactionReason, CompactionResult } from "../session/session-compaction.js";
import type { CompletionUsage } from "../llm/provider/completion-types.js";

export type CompactionEvent =
  | { type: "compaction_started"; sessionId: string; reason: CompactionReason; tokensBefore: number }
  | { type: "compaction_progress"; sessionId: string; chunk: number; chunks: number; completedChunks: number; sourceTokens: number }
  | { type: "compaction_completed"; sessionId: string; result: CompactionResult; usage: CompletionUsage; calls: number; contextUsage?: ContextUsageState }
  | { type: "compaction_failed"; sessionId: string; result: CompactionResult; usage: CompletionUsage; calls: number };

export interface CompactionStepOptions {
  signal: AbortSignal;
  providerId?: string;
  ephemeral?: boolean;
  requested?: "overflow";
  /**
   * Called once per compaction attempt with what its model calls cost,
   * whether the checkpoint was saved or not. The loop adds it to the
   * task's spend so a budget counts summaries too (ATO-1322).
   */
  onSpend?: (usd: number) => void;
}

/** Runtime owns subcalls and durability; the loop supplies an exact, pure prompt input. */
export interface ContextCompactionControl {
  open(sessionId: string, signal: AbortSignal): void;
  close(sessionId: string): void;
  beforeStep(input: BuildPromptInput, options: CompactionStepOptions): Promise<SessionState> | undefined;
}
