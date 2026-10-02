/**
 * `chat_turn_ui`: one event per turn, from the `chat` frames AgentClient
 * emits and the approval requests that arrive beside them. The outcome
 * bookkeeping mirrors turn-notify.ts (a named error frame only fails the
 * turn when no work came after it). Only counts, durations, enums and
 * built-in tool names are kept — never text.
 */

import { ERROR_CATEGORIES } from "./catalog.js";
import { toolBucket } from "./validate.js";

export interface TurnSummary {
  outcome: "completed" | "failed" | "cancelled";
  ms_to_first_token: number | null;
  ms_total: number;
  queue_wait_ms: number;
  steer_count: number;
  approvals_asked: number;
  tool_calls: number;
  tools_used: string[];
  error_category: string | null;
  coding_mode: string | null;
}

interface Turn {
  startedAt: number;
  queueWaitMs: number;
  firstTokenAt: number | null;
  sessionId: string | null;
  steers: number;
  approvals: number;
  toolCalls: number;
  tools: string[];
  heldError: boolean;
  workAfterError: boolean;
  category: string | null;
}

const WORK = new Set(["delta", "tool_progress", "progress_note", "reasoning_progress"]);
const MAX_OPEN_TURNS = 64;

export class ChatTurnTracker {
  private readonly turns = new Map<string, Turn>();
  private codingMode: string | null = null;

  constructor(
    private readonly report: (s: TurnSummary) => void,
    private readonly now: () => number = Date.now,
  ) {}

  setCodingMode(mode: unknown): void {
    if (typeof mode === "string" && mode) this.codingMode = mode;
  }

  /** The chat IPC sent the turn, after `queueWaitMs` waiting behind a switch's restart. */
  begin(turnId: string, queueWaitMs = 0): void {
    if (this.turns.size >= MAX_OPEN_TURNS) {
      const oldest = this.turns.keys().next().value;
      if (oldest !== undefined) this.turns.delete(oldest);
    }
    this.turns.set(turnId, {
      startedAt: this.now(),
      queueWaitMs: Math.max(0, Math.round(queueWaitMs)),
      firstTokenAt: null,
      sessionId: null,
      steers: 0,
      approvals: 0,
      toolCalls: 0,
      tools: [],
      heldError: false,
      workAfterError: false,
      category: null,
    });
  }

  /** An approval request: counted against the open turn on the same session. */
  approval(ev: unknown): void {
    const sid = ev && typeof ev === "object" ? (ev as { sessionId?: unknown }).sessionId : undefined;
    if (typeof sid !== "string") return;
    for (const t of this.turns.values()) {
      if (t.sessionId === sid) {
        t.approvals += 1;
        return;
      }
    }
  }

  observe(ev: { turnId?: unknown; kind?: unknown; category?: unknown; payload?: unknown }): void {
    if (typeof ev?.turnId !== "string" || typeof ev.kind !== "string") return;
    const t = this.turns.get(ev.turnId);
    if (!t) return; // a turn this window did not start through agent:chat
    const kind = ev.kind;
    const payload = ev.payload && typeof ev.payload === "object" ? (ev.payload as Record<string, unknown>) : {};
    if (kind === "session_id" && typeof payload.session_id === "string") t.sessionId = payload.session_id;
    if (kind === "delta" && t.firstTokenAt === null) t.firstTokenAt = this.now();
    if (kind === "steer_applied") t.steers += 1;
    if (kind === "tool_progress") {
      t.toolCalls += 1;
      if (typeof payload.session_id === "string") t.sessionId = payload.session_id;
      const b = toolBucket(payload.tool);
      if (b && !t.tools.includes(b) && t.tools.length < 20) t.tools.push(b);
    }
    if (kind === "error" && ev.payload) {
      // A named error frame: held until `done` says whether work followed it.
      if (!t.heldError || t.workAfterError) {
        t.heldError = true;
        t.workAfterError = false;
        t.category = categoryOf(ev.category);
      }
      return;
    }
    if (t.heldError && WORK.has(kind)) t.workAfterError = true;

    let outcome: TurnSummary["outcome"] | null = null;
    if (kind === "aborted") outcome = "cancelled";
    else if (kind === "error") {
      outcome = "failed";
      t.category = categoryOf(ev.category) ?? t.category;
    } else if (kind === "done") outcome = t.heldError && !t.workAfterError ? "failed" : "completed";
    if (!outcome) return;
    this.turns.delete(ev.turnId);
    const end = this.now();
    this.report({
      outcome,
      ms_to_first_token: t.firstTokenAt === null ? null : t.firstTokenAt - t.startedAt,
      ms_total: end - t.startedAt,
      queue_wait_ms: t.queueWaitMs,
      steer_count: t.steers,
      approvals_asked: t.approvals,
      tool_calls: t.toolCalls,
      tools_used: t.tools,
      error_category: outcome === "failed" ? t.category : null,
      coding_mode: this.codingMode,
    });
  }
}

function categoryOf(v: unknown): string | null {
  return typeof v === "string" && (ERROR_CATEGORIES as readonly string[]).includes(v) ? v : null;
}
