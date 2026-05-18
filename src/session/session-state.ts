import type {
  MemoryEntry,
  MemoryIndexEntry,
} from "../memory/memory-store.js";
import type { LessonIndexEntry } from "../memory/lessons/lesson-store.js";
import {
  appendTurn,
  type ConversationTurn,
} from "./conversation-turn.js";

export type SessionStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "awaiting_llm"
  | "completed"
  | "failed"
  | "cancelled"
  /**
   * Turn hit `agent.maxSteps` without producing `reply` or `finish`. The
   * session is otherwise healthy — the next user message can still drive
   * a new turn — but operators see `stalled` so the condition is
   * distinguishable from a clean `pending` idle.
   */
  | "stalled";

export interface KnownFact {
  text: string;
  source?: string;
}

export interface LatestResult {
  tool: string;
  status: "ok" | "error";
  summary: string;
  details?: Record<string, unknown>;
}

/**
 * Body of a skill (SKILL.md without frontmatter) loaded into the session
 * through `skill.view`. Kept in session state so the LLM does not pay the
 * token cost of re-loading the same skill on every step.
 */
export interface LoadedSkillBody {
  name: string;
  version: string;
  body: string;
  loadedAt: number;
}

/**
 * Full `args` schema for a rare tool, materialised into `### loaded-tools`
 * via `tool.view` or auto-expand after an execution error.
 */
export interface LoadedToolDescriptor {
  name: string;
  summary: string;
  argsSchema: string;
  examples?: readonly string[];
  loadedAt: number;
  source: "explicit" | "auto";
}

/**
 * Compact snapshot of the current world observable to the agent (e.g. the
 * browser ARIA tree). Kept small and deterministic so it can live in the
 * prompt tail without exploding the token budget.
 */
export interface WorldSnapshot {
  kind: "browser" | "none";
  digest: string;
  text: string;
  capturedAt: number;
}

export interface SessionState {
  id: string;
  /** Working directory for OS tools and relative paths. */
  workingDir: string;
  status: SessionStatus;
  knownFacts: KnownFact[];
  latestResult: LatestResult | null;
  loadedSkills: LoadedSkillBody[];
  /**
   * Full schemas for rare tools (progressive disclosure). Persisted with
   * the session JSON blob; capped by `agent.loadedToolsCap` (LRU).
   */
  loadedTools: LoadedToolDescriptor[];
  worldSnapshot: WorldSnapshot | null;
  stepCount: number;
  /** Number of completed macro-turns (user → 0..N tools → reply). */
  turnCount: number;
  /** Full conversation transcript in chronological order. */
  turns: ConversationTurn[];
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  /**
   * Free-form session metadata. Reserved keys (set by the runtime, not
   * the agent — agents may read but must not overwrite them):
   *
   *   - `wakeReason: { source: "user" | "scheduler" | "webhook" | "agent",
   *                    taskId?: string, webhookName?: string, at: number }`
   *     Stamped by `TaskRunner.runOne` right before `runTurn` and
   *     survives restarts. Audit-only in this milestone — not rendered
   *     into the prompt, but available to observability plumbing.
   *   - `recurringTask: boolean` + `scheduleKind: "cron" | "interval"`
   *     Stamped on persistent sessions created for recurring tasks.
   *   - `webhookName: string` + `webhookPersistent: true` — stamped on
   *     the persistent session that backs a `sessionMode="persistent"`
   *     webhook.
   *   - `ephemeralTask: true` + `scheduledBy: <sessionId>` — stamped on
   *     fresh sessions created by `tasks.schedule` with `newSession=true`.
   */
  metadata: Record<string, unknown>;
  /**
   * Ephemeral: top-K durable notes pre-fetched for the current turn.
   * Populated by the agent-loop pre-step hook, rendered by
   * `build-prompt` into the `### recalled` section. Never persisted —
   * `stripEphemeral` strips it before `SessionStore` serialisation so
   * reloaded sessions always start with a fresh recall. Undefined when
   * the recall-injection feature is disabled.
   */
  recalledNotes?: readonly MemoryEntry[];
  /**
   * Ephemeral: compact memory pointer list for the current turn.
   * Populated by the agent-loop pre-step hook, rendered by
   * `build-prompt` into the `### memory-index` section. Same
   * persistence rules as `recalledNotes`.
   */
  memoryIndex?: readonly MemoryIndexEntry[];
  /**
   * Memory-v2 phase 5. Pointer view of distilled lessons surfaced for
   * the current turn. Populated by `memory-context-provider.buildMemoryContext`
   * and rendered as `### lessons` between `### profile` and
   * `### memory-index` in the variable tail. Carries only the
   * `LessonIndexEntry` fields — the full `principle` is gated behind
   * `memory.lessons.recall { id }`.
   *
   * Ephemeral: stripped by `stripEphemeral` below before `SessionStore`
   * persistence. Cross-phase invariant 8.
   */
  recalledLessons?: readonly LessonIndexEntry[];
  // TODO(memory-v2): cross-phase invariant 8 — every new prompt-only
  // memory field added in v2 must be ephemeral (per-turn) and stripped
  // by `stripEphemeral()` below before session-store persistence:
  //   - phase 7a adds `surfacedIds?: readonly { kind, id }[]` (consumed
  //     by the vote-runner allowlist; never rendered).
  //   - phase 7b adds `recalledProcedures?: readonly Procedure[]`
  //     (rendered as `### procedures`).
  // Each phase extends `stripEphemeral()` in this file and the
  // `does not persist ephemeral …` test in `session-store.test.ts`.
}

export function createEmptySessionState(params: {
  id: string;
  workingDir: string;
  metadata?: Record<string, unknown>;
}): SessionState {
  const now = Date.now();
  return {
    id: params.id,
    workingDir: params.workingDir,
    status: "pending",
    knownFacts: [],
    latestResult: null,
    loadedSkills: [],
    loadedTools: [],
    worldSnapshot: null,
    stepCount: 0,
    turnCount: 0,
    turns: [],
    createdAt: now,
    updatedAt: now,
    lastError: null,
    metadata: params.metadata ?? {},
  };
}

export function appendFact(state: SessionState, fact: KnownFact): SessionState {
  return {
    ...state,
    knownFacts: [...state.knownFacts, fact],
    updatedAt: Date.now(),
  };
}

export function recordLatestResult(
  state: SessionState,
  result: LatestResult,
): SessionState {
  return { ...state, latestResult: result, updatedAt: Date.now() };
}

export function recordLoadedSkill(
  state: SessionState,
  entry: LoadedSkillBody,
): SessionState {
  const others = state.loadedSkills.filter((s) => s.name !== entry.name);
  return {
    ...state,
    loadedSkills: [...others, entry],
    updatedAt: Date.now(),
  };
}

/**
 * Upsert a loaded rare-tool schema and evict the oldest entry when over
 * `cap` (by `loadedAt` ascending).
 */
export function recordLoadedTool(
  state: SessionState,
  entry: Omit<LoadedToolDescriptor, "loadedAt"> & { loadedAt?: number },
  cap: number,
): SessionState {
  const loadedAt = entry.loadedAt ?? Date.now();
  const normalized: LoadedToolDescriptor = {
    name: entry.name,
    summary: entry.summary,
    argsSchema: entry.argsSchema,
    ...(entry.examples !== undefined && entry.examples.length > 0
      ? { examples: entry.examples }
      : {}),
    source: entry.source,
    loadedAt,
  };
  const without = state.loadedTools.filter((t) => t.name !== normalized.name);
  let next: LoadedToolDescriptor[] = [...without, normalized];
  const safeCap = Math.max(1, cap);
  while (next.length > safeCap) {
    const sorted = next.slice().sort((a, b) => a.loadedAt - b.loadedAt);
    const [, ...rest] = sorted;
    next = rest;
  }
  return { ...state, loadedTools: next, updatedAt: Date.now() };
}

export function recordWorldSnapshot(
  state: SessionState,
  snapshot: WorldSnapshot,
): SessionState {
  return { ...state, worldSnapshot: snapshot, updatedAt: Date.now() };
}

/**
 * Append a conversation turn and bump `updatedAt`. The caller is expected
 * to persist the new state through `SessionStore.save` — we return a fresh
 * object instead of mutating so reducer-style code stays pure.
 */
export function recordTurn(
  state: SessionState,
  turn: ConversationTurn,
): SessionState {
  return {
    ...state,
    turns: appendTurn(state.turns, turn),
    updatedAt: Date.now(),
  };
}

export function incrementTurnCount(state: SessionState): SessionState {
  return { ...state, turnCount: state.turnCount + 1, updatedAt: Date.now() };
}

/**
 * Strip ephemeral, turn-local fields before the session is persisted.
 * Callers that write to `SessionStore` go through this so reloaded
 * sessions never inherit a stale `### recalled` or `### memory-index`
 * snapshot — those are always recomputed by the pre-step hook when the
 * next turn begins.
 */
export function stripEphemeral(state: SessionState): SessionState {
  if (
    state.recalledNotes === undefined &&
    state.memoryIndex === undefined &&
    state.recalledLessons === undefined
  ) {
    return state;
  }
  const {
    recalledNotes: _r,
    memoryIndex: _m,
    recalledLessons: _l,
    ...rest
  } = state;
  return rest;
}
