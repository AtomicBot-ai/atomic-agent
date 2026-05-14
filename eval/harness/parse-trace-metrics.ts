import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Aggregate diagnostic metrics from a session trace NDJSON file.
 *
 * We deliberately keep the parser local instead of importing from `src/`
 * — the eval harness must keep working even if the `TraceEvent` shape is
 * mid-migration, and unknown event types are harmless here. Anything we
 * don't recognise is ignored.
 */

export interface ToolInvocationSummary {
  tool: string;
  status: "ok" | "error";
}

export interface TraceMetrics {
  /** True when the file existed and parsed at least one valid line. */
  found: boolean;
  stepCount: number;
  totalPromptTokens: number;
  totalPredictedTokens: number;
  cacheHits: number;
  parseRetries: number;
  loopDetected: number;
  toolErrorCount: number;
  batchCount: number;
  maxBatchSize: number;
  toolInvocations: ToolInvocationSummary[];
  /** Last `error.category` seen, or null when no error event was emitted. */
  failureCategory: string | null;
  /** Last `error.message`, useful for the report row. */
  failureMessage: string | null;
}

export async function collectTraceMetrics(path: string): Promise<TraceMetrics> {
  const empty: TraceMetrics = {
    found: false,
    stepCount: 0,
    totalPromptTokens: 0,
    totalPredictedTokens: 0,
    cacheHits: 0,
    parseRetries: 0,
    loopDetected: 0,
    toolErrorCount: 0,
    batchCount: 0,
    maxBatchSize: 0,
    toolInvocations: [],
    failureCategory: null,
    failureMessage: null,
  };
  if (!existsSync(path)) return empty;

  const metrics: TraceMetrics = { ...empty, toolInvocations: [] };
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    metrics.found = true;
    const type = event.type;
    if (type === "step_started") {
      metrics.stepCount += 1;
    } else if (type === "prompt_captured") {
      const tokens = event.tokens as { total?: number } | undefined;
      if (tokens && typeof tokens.total === "number") {
        metrics.totalPromptTokens += tokens.total;
      }
      if (event.cacheReused === true) metrics.cacheHits += 1;
    } else if (type === "llm_completion") {
      const timing = event.timing as { predictedTokens?: number } | undefined;
      if (timing && typeof timing.predictedTokens === "number") {
        metrics.totalPredictedTokens += timing.predictedTokens;
      }
    } else if (type === "tool_invocation") {
      const tool = typeof event.tool === "string" ? event.tool : "unknown";
      const status = event.status === "error" ? "error" : "ok";
      const batchSize = typeof event.batchSize === "number" ? event.batchSize : 1;
      const batchIndex = typeof event.batchIndex === "number" ? event.batchIndex : 0;
      if (status === "error") metrics.toolErrorCount += 1;
      if (batchSize > 1 && batchIndex === 0) metrics.batchCount += 1;
      metrics.maxBatchSize = Math.max(metrics.maxBatchSize, batchSize);
      metrics.toolInvocations.push({ tool, status });
    } else if (type === "parse_retry") {
      metrics.parseRetries += 1;
    } else if (type === "loop_detected") {
      metrics.loopDetected += 1;
    } else if (type === "error") {
      if (typeof event.category === "string") {
        metrics.failureCategory = event.category;
      }
      if (typeof event.message === "string") {
        metrics.failureMessage = event.message;
      }
    }
  }

  rl.close();
  stream.close();
  return metrics;
}
