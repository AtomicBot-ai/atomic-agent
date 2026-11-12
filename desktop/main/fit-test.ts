/**
 * ATO-1091 (desktop half of the model fit-test, epic ATO-994): what
 * `atag models fit-test --json` (ATO-1090) prints, read into one shape the
 * models page can draw. Pure: fit-test-ipc.ts runs the command, this file
 * only reads its text (test/fit-test.test.mjs).
 *
 * The contract the window expects from the agent:
 *
 *   `atag models --help` lists a `fit-test` subcommand. An agent without it
 *   gets no "Find the best model" entry at all.
 *
 *   `atag models fit-test --json [--models a,b,c]` prints one JSON object per
 *   line on stdout:
 *     {"type":"progress","model":"<id>","modelIndex":1,"models":3,
 *      "task":4,"tasks":10,"phase":"loading"|"running"|"judging"}
 *     {"type":"result","tasks":10,"winner":"<id>"|null,"models":[
 *       {"id":"<id>","name":"Qwen 3 8B","accuracy":0.8,"passed":8,"total":10,
 *        "avgSeconds":12.4,"tokensPerSec":25.1,"peakMemoryBytes":5583457484,
 *        "error":"<why this model did not finish>"}]}
 *   Any other line (logs, progress bars) is ignored. A single JSON document
 *   for the whole stdout is read too. SIGTERM stops the run; the agent puts
 *   back the model the chats used before.
 */

export type FitPhase = "loading" | "running" | "judging";

export interface FitProgress {
  model: string | null;
  modelIndex: number | null;
  models: number | null;
  task: number | null;
  tasks: number | null;
  phase: FitPhase | null;
}

export interface FitModelResult {
  id: string;
  name: string | null;
  /** 0..1, null when the model did not finish. */
  accuracy: number | null;
  passed: number | null;
  total: number | null;
  avgSeconds: number | null;
  tokensPerSec: number | null;
  peakMemoryBytes: number | null;
  error: string | null;
}

export interface FitResult {
  tasks: number | null;
  winner: string | null;
  models: FitModelResult[];
}

export type FitLine = { kind: "progress"; progress: FitProgress } | { kind: "result"; result: FitResult } | null;

/** Whether `atag models --help` names the fit-test subcommand. */
export function fitTestListed(helpText: string): boolean {
  return /^\s*fit-test\b/m.test(String(helpText || ""));
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** 0..1; an agent that says 80 for 80% is read as 0.8. */
function fraction(v: unknown, passed: number | null, total: number | null): number | null {
  const n = num(v);
  if (n !== null) return n > 1 ? Math.min(1, n / 100) : n;
  return passed !== null && total ? Math.min(1, passed / total) : null;
}

function readModel(raw: unknown): FitModelResult | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const id = str(m.id);
  if (!id) return null;
  const passed = num(m.passed);
  const total = num(m.total);
  return {
    id,
    name: str(m.name),
    accuracy: fraction(m.accuracy, passed, total),
    passed,
    total,
    avgSeconds: num(m.avgSeconds),
    tokensPerSec: num(m.tokensPerSec),
    peakMemoryBytes: num(m.peakMemoryBytes),
    error: str(m.error),
  };
}

/** The result object, or null when it carries no model. */
export function readFitResult(raw: unknown): FitResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.models)) return null;
  const models = r.models.map(readModel).filter((m): m is FitModelResult => m !== null);
  if (!models.length) return null;
  const winner = str(r.winner);
  return { tasks: num(r.tasks), winner: winner && models.some((m) => m.id === winner) ? winner : null, models };
}

function readProgress(r: Record<string, unknown>): FitProgress {
  const phase = r.phase === "loading" || r.phase === "running" || r.phase === "judging" ? r.phase : null;
  return {
    model: str(r.model),
    modelIndex: num(r.modelIndex),
    models: num(r.models),
    task: num(r.task),
    tasks: num(r.tasks),
    phase,
  };
}

/** One stdout line: progress, the result, or null for anything else. */
export function parseFitLine(line: string): FitLine {
  const t = String(line || "").trim();
  if (!t.startsWith("{")) return null;
  let raw: unknown;
  try { raw = JSON.parse(t); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type === "progress") return { kind: "progress", progress: readProgress(r) };
  if (r.type === "result" || (r.type === undefined && Array.isArray(r.models))) {
    const result = readFitResult(r);
    return result ? { kind: "result", result } : null;
  }
  return null;
}

/** The result in a whole stdout: the last result line, else the stdout as one document. */
export function fitResultFromStdout(stdout: string): FitResult | null {
  const lines = String(stdout || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const p = parseFitLine(lines[i]!);
    if (p && p.kind === "result") return p.result;
  }
  try {
    const whole = JSON.parse(String(stdout || "").trim()) as unknown;
    return readFitResult(whole);
  } catch {
    return null;
  }
}

/** The ids to pass as `--models`: 2 or 3 distinct model ids, else none (the agent picks). */
export function fitModelArgs(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const clean = [...new Set(ids.filter((id): id is string => typeof id === "string" && /^[\w.:-]{1,96}$/.test(id)))];
  return clean.length >= 2 ? ["--models", clean.slice(0, 3).join(",")] : [];
}
