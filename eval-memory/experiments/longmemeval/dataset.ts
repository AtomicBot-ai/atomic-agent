/**
 * LongMemEval dataset loader + types.
 *
 * Source: https://github.com/xiaowu0162/LongMemEval. The campaign
 * targets `LongMemEval_S` (~115K tokens per haystack, the smallest
 * tier that still stresses long-context recall) but the loader is
 * shape-agnostic — `S` / `M` / `Oracle` all share the same per-row
 * schema.
 *
 * The dataset is not shipped with the agent. Operators download
 * `longmemeval_s.json` from the upstream `data/` folder and place
 * it at `eval-memory/datasets/longmemeval/longmemeval_s.json`.
 *
 * Row schema (matches the published files):
 *
 *   {
 *     "question_id":   "q123",
 *     "question_type": "single-session-user" | "single-session-assistant" |
 *                      "single-session-preference" | "multi-session" |
 *                      "temporal-reasoning" | "knowledge-update",
 *     "question":      "What did Alice say about Lisbon?",
 *     "answer":        "She booked hotel Avenida.",
 *     "haystack_sessions": [ [ {role,content}, ... ], [ ... ], ... ],
 *     "answer_session_ids": ["0", "3"]
 *   }
 *
 * Question-type → 5-axis mapping (PLAN.md Phase 3):
 *
 *   single-session-user        → information_extraction
 *   single-session-assistant   → information_extraction
 *   single-session-preference  → information_extraction
 *   multi-session              → multi_session_reasoning
 *   temporal-reasoning         → temporal_reasoning
 *   knowledge-update           → knowledge_updates
 *
 * LongMemEval also ships an explicit "abstention" axis — questions
 * whose haystack does not contain the answer and the model is
 * expected to say "I don't know". Those rows carry a `is_abstention`
 * boolean in the canonical schema; we pass it through verbatim.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
export const LONGMEMEVAL_DEFAULT_PATH = resolve(
  REPO_ROOT,
  "eval-memory",
  "datasets",
  "longmemeval",
  "longmemeval_s.json",
);

export type LongMemEvalAxis =
  | "information_extraction"
  | "multi_session_reasoning"
  | "temporal_reasoning"
  | "knowledge_updates"
  | "abstention";

export const LONGMEMEVAL_AXES: readonly LongMemEvalAxis[] = [
  "information_extraction",
  "multi_session_reasoning",
  "temporal_reasoning",
  "knowledge_updates",
  "abstention",
];

export interface LongMemEvalTurn {
  role: string;
  content: string;
}

export interface LongMemEvalRow {
  questionId: string;
  questionType: string;
  axis: LongMemEvalAxis;
  question: string;
  goldAnswer: string;
  isAbstention: boolean;
  haystackSessions: LongMemEvalTurn[][];
  answerSessionIds: string[];
}

export class LongMemEvalDatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LongMemEvalDatasetError";
  }
}

interface RawRow {
  question_id?: string;
  question_type?: string;
  question?: string;
  answer?: string;
  is_abstention?: boolean;
  haystack_sessions?: unknown;
  answer_session_ids?: unknown;
}

export function loadLongMemEvalDataset(
  opts: { path?: string } = {},
): LongMemEvalRow[] {
  const path =
    opts.path ??
    process.env.ATOMIC_AGENT_LONGMEMEVAL_PATH ??
    LONGMEMEVAL_DEFAULT_PATH;
  if (!existsSync(path)) {
    throw new LongMemEvalDatasetError(
      `LongMemEval dataset not found at ${path}. Download longmemeval_s.json ` +
        `from https://github.com/xiaowu0162/LongMemEval and place it at the ` +
        `default path, or set ATOMIC_AGENT_LONGMEMEVAL_PATH to point elsewhere.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LongMemEvalDatasetError(`failed to parse ${path}: ${msg}`);
  }
  if (!Array.isArray(raw)) {
    throw new LongMemEvalDatasetError(
      `${path}: expected a top-level JSON array of QA rows`,
    );
  }
  const out: LongMemEvalRow[] = [];
  for (const entry of raw as RawRow[]) {
    const row = normaliseRow(entry);
    if (row) out.push(row);
  }
  if (out.length === 0) {
    throw new LongMemEvalDatasetError(
      `${path}: zero valid rows after parsing`,
    );
  }
  return out;
}

function normaliseRow(raw: RawRow): LongMemEvalRow | null {
  if (!raw || typeof raw !== "object") return null;
  const qid = typeof raw.question_id === "string" ? raw.question_id : null;
  const qtype = typeof raw.question_type === "string" ? raw.question_type : null;
  const question = typeof raw.question === "string" ? raw.question : null;
  const answer = typeof raw.answer === "string" ? raw.answer : "";
  if (!qid || !qtype || !question) return null;

  const haystackSessions: LongMemEvalTurn[][] = [];
  if (Array.isArray(raw.haystack_sessions)) {
    for (const session of raw.haystack_sessions) {
      if (!Array.isArray(session)) continue;
      const turns: LongMemEvalTurn[] = [];
      for (const t of session as Array<Record<string, unknown>>) {
        if (!t || typeof t !== "object") continue;
        const role = typeof t.role === "string" ? t.role : "user";
        const content = typeof t.content === "string" ? t.content : "";
        if (content.length === 0) continue;
        turns.push({ role, content });
      }
      if (turns.length > 0) haystackSessions.push(turns);
    }
  }
  const answerSessionIds = Array.isArray(raw.answer_session_ids)
    ? (raw.answer_session_ids as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : [];
  const isAbstention = raw.is_abstention === true;
  if (haystackSessions.length === 0) return null;
  return {
    questionId: qid,
    questionType: qtype,
    axis: mapQuestionTypeToAxis(qtype, isAbstention),
    question,
    goldAnswer: answer,
    isAbstention,
    haystackSessions,
    answerSessionIds,
  };
}

function mapQuestionTypeToAxis(
  qtype: string,
  isAbstention: boolean,
): LongMemEvalAxis {
  if (isAbstention) return "abstention";
  switch (qtype) {
    case "single-session-user":
    case "single-session-assistant":
    case "single-session-preference":
      return "information_extraction";
    case "multi-session":
      return "multi_session_reasoning";
    case "temporal-reasoning":
      return "temporal_reasoning";
    case "knowledge-update":
      return "knowledge_updates";
    default:
      // Unknown / future question type — bucket as info-extraction so
      // the row still rolls up somewhere instead of disappearing.
      return "information_extraction";
  }
}

/**
 * Render one haystack as a list of user prompts (one per session)
 * the agent will consume turn-by-turn before the QA pivot. Matches
 * the LoCoMo `renderConversationPrompts` style so the two runners
 * exercise the memory layer the same way.
 */
export function renderHaystackPrompts(row: LongMemEvalRow): string[] {
  return row.haystackSessions.map((turns, idx) => {
    const lines: string[] = [`[session_${idx + 1}]`];
    for (const t of turns) {
      const role = t.role || "user";
      lines.push(`${role}: ${t.content}`);
    }
    lines.push(
      "Remember this session as background context. Reply with 'OK' and " +
        "store anything noteworthy.",
    );
    return lines.join("\n");
  });
}
