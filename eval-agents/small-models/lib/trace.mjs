// Reads the agent's trace NDJSON files from a (fresh, per-run) state dir and
// folds them into the few numbers the bench reports. Kept local and lenient
// on purpose (same reasoning as eval/harness/parse-trace-metrics.ts): unknown
// event types are ignored, so a trace-shape change does not break old runs.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function emptyTrace() {
  return {
    found: false,
    steps: 0,
    turns: 0,
    promptTokens: 0,
    maxPromptTokens: 0,
    predictedTokens: 0,
    toolCalls: [],
    toolErrors: 0,
    compactions: 0,
    compactionFailures: 0,
    parseRetries: 0,
    loopDetected: 0,
    truncatedCompletions: 0,
    lastError: null,
  };
}

/** Fold NDJSON text (one or more trace files concatenated) into metrics. */
export function foldTrace(ndjson) {
  const m = emptyTrace();
  for (const line of ndjson.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try {
      e = JSON.parse(t);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object") continue;
    m.found = true;
    switch (e.type) {
      case "step_started":
        m.steps += 1;
        break;
      case "turn_finished":
        m.turns += 1;
        break;
      case "prompt_captured": {
        const total = e.tokens?.total;
        if (typeof total === "number") {
          m.promptTokens += total;
          m.maxPromptTokens = Math.max(m.maxPromptTokens, total);
        }
        break;
      }
      case "llm_completion": {
        const p = e.timing?.predictedTokens;
        if (typeof p === "number") m.predictedTokens += p;
        if (e.truncated === true) m.truncatedCompletions += 1;
        break;
      }
      case "tool_invocation": {
        const status = e.status === "error" ? "error" : "ok";
        if (status === "error") m.toolErrors += 1;
        m.toolCalls.push({
          tool: typeof e.tool === "string" ? e.tool : "unknown",
          status,
          args: e.args && typeof e.args === "object" ? e.args : {},
        });
        break;
      }
      case "compaction_completed":
        m.compactions += 1;
        break;
      case "compaction_failed":
        m.compactionFailures += 1;
        break;
      case "parse_retry":
        m.parseRetries += 1;
        break;
      case "loop_detected":
        m.loopDetected += 1;
        break;
      case "error":
        m.lastError = typeof e.message === "string" ? e.message : (e.category ?? "error");
        break;
      default:
        break;
    }
  }
  return m;
}

/** All `<stateDir>/traces/*.ndjson`, in name order. The state dir is per-run, so this is one session. */
export function readTraceDir(stateDir) {
  const dir = join(stateDir, "traces");
  if (!existsSync(dir)) return { text: "", files: [] };
  const files = readdirSync(dir).filter((f) => f.endsWith(".ndjson")).sort();
  const text = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  return { text, files: files.map((f) => join(dir, f)) };
}

/**
 * True when the agent looked at a big file piecemeal: a search tool, a shell
 * filter (grep/rg/awk/sed -n/head/tail/wc), or a ranged read (offset/limit).
 * Used by the needle tasks; reading a 1M-token file whole is the failure mode.
 */
export function usedChunkedAccess(toolCalls) {
  const searchTool = /(grep|search|find|glob)/i;
  const argHint = /\b(grep|rg|awk|sed\s+-n|head|tail|wc|split)\b|"(offset|limit|startLine|endLine|start_line|end_line|fromLine|lines?|range)"\s*:/i;
  return toolCalls.some((c) => searchTool.test(c.tool) || argHint.test(JSON.stringify(c.args)));
}
