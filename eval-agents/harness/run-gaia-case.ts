import type { AgentAdapter } from "./agent-adapter.js";
import type { GaiaRow, GaiaAgentRunResult } from "./gaia-types.js";
import { buildGaiaUserPrompt, extractFinalAnswer } from "./extract-answer.js";
import { questionScorer } from "./score-gaia.js";
import { createGaiaWorkspace } from "./temp-workspace.js";
import { preserveTraceFiles } from "./preserve-traces.js";

export interface RunGaiaCaseOptions {
  adapter: AgentAdapter;
  row: GaiaRow;
  chatUrl: string;
  embedUrl: string | null;
  maxSteps?: number;
  timeoutMs?: number;
  split?: "validation" | "test";
  /**
   * When set, per-case NDJSON traces are copied into
   * `<tracesOutDir>/<taskId>/` before the temp-workspace is deleted.
   */
  tracesOutDir?: string;
}

export async function runGaiaCase(opts: RunGaiaCaseOptions): Promise<GaiaAgentRunResult> {
  const missing = opts.adapter.probeRequirements();
  if (missing.length > 0) {
    return {
      agentId: opts.adapter.id,
      taskId: opts.row.task_id,
      rawReply: "",
      extractedAnswer: "",
      correct: false,
      metrics: emptyMetrics(),
      skipped: true,
      skipReason: missing.join("; "),
      error: null,
    };
  }

  const workspace = createGaiaWorkspace(opts.row.task_id, opts.row, opts.split ?? "validation");
  try {
    const attachmentHint = opts.row.file_name || null;
    const prompt = buildGaiaUserPrompt(opts.row.Question, attachmentHint);
    const raw = await opts.adapter.runQuestion({
      row: opts.row,
      workingDir: workspace.workingDir,
      stateDir: workspace.stateDir,
      prompt,
      maxSteps: opts.maxSteps ?? 30,
      timeoutMs: opts.timeoutMs ?? 600_000,
      chatUrl: opts.chatUrl,
      embedUrl: opts.embedUrl,
    });

    const extracted = extractFinalAnswer(raw.rawReply);
    const correct = questionScorer(extracted, opts.row["Final answer"]);

    return {
      agentId: opts.adapter.id,
      taskId: opts.row.task_id,
      rawReply: raw.rawReply,
      extractedAnswer: extracted,
      correct,
      metrics: raw.metrics,
      skipped: false,
      skipReason: null,
      error: raw.error,
    };
  } finally {
    if (opts.tracesOutDir) {
      preserveTraceFiles(workspace.stateDir, opts.tracesOutDir, opts.row.task_id);
    }
    workspace.cleanup();
  }
}

function emptyMetrics(): GaiaAgentRunResult["metrics"] {
  return {
    stepCount: null,
    promptTokens: null,
    predictedTokens: null,
    toolErrors: null,
    wallClockMs: 0,
    timedOut: false,
    exitCode: null,
  };
}
