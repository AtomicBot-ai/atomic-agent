/**
 * Row shape for GAIA validation metadata (2023 split).
 * Mirrors HF columns: task_id, Question, Level, Final answer,
 * file_name, file_path.
 */

export interface GaiaRow {
  task_id: string;
  Question: string;
  Level: number;
  "Final answer": string;
  file_name: string;
  file_path: string;
  /**
   * Optional inline fixture body for smoke rows committed in-repo.
   * When set, the harness writes this text into the per-case workspace
   * instead of copying from the HF snapshot tree.
   */
  fixture_file_text?: string;
}

export interface GaiaRunMetrics {
  stepCount: number | null;
  promptTokens: number | null;
  predictedTokens: number | null;
  toolErrors: number | null;
  wallClockMs: number;
  timedOut: boolean;
  exitCode: number | null;
}

export interface GaiaAgentRunResult {
  agentId: string;
  taskId: string;
  rawReply: string;
  extractedAnswer: string;
  correct: boolean;
  metrics: GaiaRunMetrics;
  skipped: boolean;
  skipReason: string | null;
  error: string | null;
}
