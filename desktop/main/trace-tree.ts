/**
 * ATO-639 — the trace of one chat as a tree, for Settings › Diagnostics'
 * Timeline: turns, the steps of each turn, and under each step its model
 * calls, tool calls and the notable things that happened (a parse retry, a
 * loop warning, an error).
 *
 * Source: the same append-only file `cli:traceTools` reads,
 * <stateDir>/traces/<sessionId>.ndjson, which `serve` writes (the agent's
 * TraceEvent union in src/tracing/trace/trace-event.ts). Nothing here calls
 * the agent and nothing here imports electron: parseTraceTree is pure.
 *
 * Times. Every row has `startMs`, an offset from its turn's start, and
 * `durationMs` (null when the trace does not measure it).
 *   turn   turn_started → turn_finished (its durationMs when written)
 *   step   step_started → step_finished (its durationMs when written)
 *   model  ends at llm_completion.ts; lasts the server's promptMs +
 *          predictedMs when the provider said, else the time since the
 *          step's previous mark (step start, an earlier attempt)
 *   tool   the step's last llm_completion → tool_invocation.ts, the same
 *          interval traceTools measures and the TUI's live card shows
 *   event  a mark with no duration
 * A file a later `serve` appended to restarts `seq` and may restart
 * `turnIndex`, so turns are cut in file order, never by index alone.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type TraceNodeKind = "turn" | "step" | "llm" | "tool" | "event";

export interface TraceNode {
  kind: TraceNodeKind;
  name: string;
  /** Offset from the turn's start, ms. */
  startMs: number;
  durationMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
  error: boolean;
  warn: boolean;
  /** A short line for the tooltip: a tool's summary, an error's message. */
  detail: string;
  children: TraceNode[];
}

export interface TraceTurn extends TraceNode {
  kind: "turn";
  /** The agent's turnIndex (it can repeat across appended runs). */
  turnIndex: number;
  /** Wall-clock start, ms. */
  ts: number;
  userMessage: string;
  model: string;
  reason: string;
}

export interface TraceTree {
  turns: TraceTurn[];
  /** Turns left out at the start because only the newest are sent. */
  omittedTurns: number;
}

/** The newest turns sent to the window; a long chat's whole file is not. */
export const TRACE_TREE_MAX_TURNS = 40;
const DETAIL_CHARS = 240;

/** Notable rows shown as marks, with the words the row is named by. */
const EVENT_NAMES: Record<string, string> = {
  parse_retry: "Parse retry",
  parse_failure_recovered: "Unreadable reply, retried",
  empty_completion_recovered: "Empty reply, retried",
  reply_time_limit_retried: "Time limit, retried",
  answer_continued: "Reply cut, continued",
  completion_truncated: "Reply cut off",
  loop_detected: "Repeated call",
  batch_trimmed: "Batch trimmed",
  provider_waiting: "Waiting for provider",
  provider_recovered: "Provider back",
  prompt_repacked: "Prompt repacked",
  compaction: "Context compacted",
  task_continued: "Task continued",
};
const WARN_EVENTS = new Set(["parse_retry", "parse_failure_recovered", "empty_completion_recovered", "reply_time_limit_retried",
  "completion_truncated", "loop_detected", "batch_trimmed", "provider_waiting"]);

type Row = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const clip = (s: string, n = DETAIL_CHARS): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};
const add = (a: number | null, b: number | null): number | null => (b === null ? a : (a ?? 0) + b);

function node(kind: TraceNodeKind, name: string, startMs: number): TraceNode {
  return { kind, name, startMs, durationMs: null, tokensIn: null, tokensOut: null, cachedTokens: null, costUsd: null, error: false, warn: false, detail: "", children: [] };
}

interface OpenTurn {
  turn: TraceTurn;
  steps: Map<number, { node: TraceNode; ts: number; mark: number; lastCompletion: number | null }>;
}

function routeModel(route: unknown): string {
  const main = route && typeof route === "object" ? ((route as Row)["main"] as Row | undefined) : undefined;
  if (!main || typeof main !== "object") return "";
  const model = str(main["model"]);
  const provider = str(main["providerId"]);
  return model ? (provider ? `${provider}/${model}` : model) : provider;
}

/** NDJSON of one session's trace → its turns, oldest first. */
export function parseTraceTree(text: string, maxTurns = TRACE_TREE_MAX_TURNS): TraceTree {
  const turns: TraceTurn[] = [];
  let cur: OpenTurn | null = null;

  const open = (turnIndex: number, ts: number): OpenTurn => {
    const turn = node("turn", `Turn ${turnIndex + 1}`, 0) as TraceTurn;
    Object.assign(turn, { turnIndex, ts, userMessage: "", model: "", reason: "" });
    turns.push(turn);
    cur = { turn, steps: new Map() };
    return cur;
  };
  const turnFor = (row: Row, ts: number): OpenTurn | null => {
    const ti = num(row["turnIndex"]);
    if (ti === null) return cur;
    // A row after turn_finished with the same index (a compaction, a task leg) stays in that turn.
    if (!cur || cur.turn.turnIndex !== ti) return open(ti, ts);
    return cur;
  };
  const stepFor = (t: OpenTurn, row: Row, ts: number) => {
    const si = num(row["stepIndex"]);
    if (si === null) return null;
    let s = t.steps.get(si);
    if (!s) {
      const n = node("step", `Step ${si + 1}`, Math.max(0, ts - t.turn.ts));
      t.turn.children.push(n);
      s = { node: n, ts, mark: ts, lastCompletion: null };
      t.steps.set(si, s);
    }
    return s;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] !== "{") continue;
    let row: Row;
    try {
      row = JSON.parse(line) as Row;
    } catch {
      continue;
    }
    const type = str(row["type"]);
    const ts = num(row["ts"]);
    if (!type || ts === null) continue;

    if (type === "turn_started") {
      const t = open(num(row["turnIndex"]) ?? 0, ts);
      t.turn.userMessage = clip(str(row["userMessage"]), 160);
      t.turn.model = routeModel(row["route"]);
      continue;
    }
    const t = turnFor(row, ts);
    if (!t) continue;   // session_started and anything before the first turn
    const rel = Math.max(0, ts - t.turn.ts);

    if (type === "turn_finished") {
      t.turn.durationMs = num(row["durationMs"]) ?? rel;
      t.turn.reason = str(row["reason"]);
      continue;
    }
    if (type === "step_started") {
      const s = stepFor(t, row, ts);
      if (s) { s.node.startMs = rel; s.ts = ts; s.mark = ts; }
      continue;
    }
    if (type === "step_finished") {
      const s = stepFor(t, row, ts);
      if (s) {
        s.node.durationMs = num(row["durationMs"]) ?? Math.max(0, ts - s.ts);
        if (!s.node.detail) s.node.detail = clip(str(row["summary"]));
      }
      continue;
    }
    if (type === "llm_completion") {
      const s = stepFor(t, row, ts);
      if (!s) continue;
      const timing = (row["timing"] ?? null) as Row | null;
      const server = timing ? (num(timing["promptMs"]) ?? 0) + (num(timing["predictedMs"]) ?? 0) : 0;
      const dur = server > 0 ? server : Math.max(0, ts - s.mark);
      const n = node("llm", row["attempt"] === 2 ? "Model call (retry)" : "Model call", Math.max(s.node.startMs, rel - dur));
      n.durationMs = Math.min(dur, rel - n.startMs);
      n.tokensIn = timing ? num(timing["promptTokens"]) : null;
      n.tokensOut = timing ? num(timing["predictedTokens"]) : null;
      n.cachedTokens = num(row["cacheHitTokens"]);
      n.costUsd = num(row["costUsd"]);
      n.warn = row["truncated"] === true;
      n.detail = str(row["modelId"]);
      if (!t.turn.model && n.detail) t.turn.model = n.detail;
      s.node.children.push(n);
      s.mark = ts;
      s.lastCompletion = ts;
      continue;
    }
    if (type === "tool_invocation") {
      const s = stepFor(t, row, ts);
      if (!s) continue;
      const from = s.lastCompletion ?? s.mark;
      const n = node("tool", str(row["tool"]) || "tool", Math.max(0, from - t.turn.ts));
      n.durationMs = Math.max(0, ts - from);
      n.error = row["status"] === "error";
      n.detail = clip(str(row["summary"]));
      s.node.children.push(n);
      continue;
    }
    if (type === "error" || EVENT_NAMES[type]) {
      const s = stepFor(t, row, ts);
      const n = node("event", type === "error" ? "Error" : EVENT_NAMES[type]!, rel);
      n.error = type === "error";
      n.warn = WARN_EVENTS.has(type);
      n.detail = clip(str(row["message"]) || str(row["reason"]) || str(row["tool"]));
      (s ? s.node : t.turn).children.push(n);
      if (s && type === "parse_retry") s.mark = ts;
    }
  }

  for (const turn of turns) finishTurn(turn);
  const omittedTurns = Math.max(0, turns.length - maxTurns);
  return { turns: omittedTurns ? turns.slice(omittedTurns) : turns, omittedTurns };
}

/** Roll tokens, cost and flags up from the leaves; fill a missing end. */
function finishTurn(turn: TraceTurn): void {
  let end = 0;
  for (const step of turn.children) {
    if (step.kind !== "step") { end = Math.max(end, step.startMs); continue; }
    let stepEnd = step.startMs + (step.durationMs ?? 0);
    for (const c of step.children) {
      step.tokensIn = add(step.tokensIn, c.tokensIn);
      step.tokensOut = add(step.tokensOut, c.tokensOut);
      step.cachedTokens = add(step.cachedTokens, c.cachedTokens);
      step.costUsd = add(step.costUsd, c.costUsd);
      step.error ||= c.error;
      step.warn ||= c.warn;
      stepEnd = Math.max(stepEnd, c.startMs + (c.durationMs ?? 0));
    }
    if (step.durationMs === null && stepEnd > step.startMs) step.durationMs = stepEnd - step.startMs;
    turn.tokensIn = add(turn.tokensIn, step.tokensIn);
    turn.tokensOut = add(turn.tokensOut, step.tokensOut);
    turn.cachedTokens = add(turn.cachedTokens, step.cachedTokens);
    turn.costUsd = add(turn.costUsd, step.costUsd);
    end = Math.max(end, stepEnd);
  }
  turn.error = turn.children.some((c) => c.error);
  turn.warn = turn.children.some((c) => c.warn);
  if (turn.durationMs === null) turn.durationMs = end;
  if (!turn.detail) turn.detail = turn.userMessage;
}

/** One session's trace file → its tree. Same file, same guards as traceTools. */
export async function readTraceTree(
  stateDir: string,
  sessionId: string,
): Promise<{ ok: boolean; tree?: TraceTree; error?: string }> {
  if (!/^[\w.-]{1,80}$/.test(sessionId)) return { ok: false, error: "bad session id" };
  if (!stateDir) return { ok: false, error: "no state dir" };
  let text: string;
  try {
    text = await readFile(join(stateDir, "traces", `${sessionId}.ndjson`), "utf8");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "no trace" };
  }
  return { ok: true, tree: parseTraceTree(text) };
}
