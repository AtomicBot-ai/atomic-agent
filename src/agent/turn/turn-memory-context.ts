import type { AgentLoopDependencies, RunTurnOptions } from "../agent-contract.js";
import type { SessionState } from "../../session/session-state.js";
import { isFinalReplyTurn, isStoppedTurnMarker } from "../../session/conversation-turn.js";

export type TurnMemoryDependencies = Pick<
  AgentLoopDependencies,
  "memoryContextProvider" | "metrics" | "logger"
>;

/**
 * Memory-v2 phase 2. Ceiling on the per-turn note allowlist handed to
 * `reflect()` as `recalledMemoryIds`.
 *
 * The allowlist is the union of every note surfaced across the turn,
 * so it grows once per step. It is rendered verbatim into the
 * link-generator prompt (one `[id] body` row per candidate, and that
 * prompt has no cap of its own) and hydrated again for the vote
 * runner and the EVOLVE directives. Bounded only by
 * `memory.notes.maxEntries`, a long task-mode turn (`task.maxSteps`
 * defaults to 1000) could hand a multi-KB candidate block to a
 * sub-call whose reported failure mode is already `timeout`.
 *
 * 32 is several recalls' worth — `memory.recallInjection.k` is 3 plus
 * up to `maxExpanded: 12` graph-expanded ids per refresh — and still
 * renders in ~4 KB at the prompt's 120-char preview. The most
 * RECENTLY surfaced ids win: they describe where the turn actually
 * went, and any turn short enough to fit keeps its turn-start recall
 * (the shape issue #464 is about).
 *
 * Capping here rather than in the prompt builder keeps the prompt and
 * the parser's anti-feedback-loop allowlist derived from the same
 * list — the runner builds that allowlist from `input.candidates`, so
 * the two can never drift.
 */
export const MAX_SURFACED_NOTE_ALLOWLIST = 32;

export async function refreshMemoryContext(
  deps: TurnMemoryDependencies,
  state: SessionState,
  options: RunTurnOptions,
): Promise<SessionState> {
  if (!deps.memoryContextProvider) return state;
  // An ephemeral (fusion worker) turn neither reads nor primes memory:
  // its prompt is the orchestrator's instruction, not the operator's
  // history, and the recall would only pull unrelated notes into it.
  if (options.ephemeral) return state;
  try {
    const ctx = await deps.memoryContextProvider.buildMemoryContext({
      sessionId: state.id,
      userMessage: options.userMessage ?? null,
      toolResultSummaries: collectRecentToolResultSummaries(state),
      // v2.5 (Phase A). Project the session's
      // existing `user`/`assistant_reply` turns into the shape the
      // rewriter decorator expects. The current user message lives
      // in `userMessage` above, so we exclude it from this list to
      // keep semantics clean: `recentTurns` is "history BEFORE this
      // turn's user message". The agent loop has already appended
      // the current user turn to `state.turns` at this point, so we
      // drop the trailing user row whose `text` matches.
      recentTurns: collectRecentUserAssistantTurns(state, options.userMessage),
      signal: options.signal,
    });
    const lessons = ctx.lessons ?? [];
    if (lessons.length > 0) {
      deps.metrics?.recordLessonsRecalled({
        sessionId: state.id,
        hits: lessons.length,
      });
    }
    const procedures = ctx.procedures ?? [];
    if (procedures.length > 0) {
      deps.metrics?.recordProceduresRecalled({
        sessionId: state.id,
        hits: procedures.length,
      });
    }
    return {
      ...state,
      recalledNotes: ctx.recalled,
      memoryIndex: ctx.index,
      recalledLessons: lessons,
      recalledProcedures: procedures,
    };
  } catch (err) {
    deps.logger?.warn("memory context provider failed", {
      sessionId: state.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return state;
  }
}

function collectRecentToolResultSummaries(
  state: SessionState,
  maxEntries = 4,
): string[] {
  const summaries: string[] = [];
  for (
    let i = state.turns.length - 1;
    i >= 0 && summaries.length < maxEntries;
    i -= 1
  ) {
    const turn = state.turns[i];
    if (turn?.kind !== "tool_result") continue;
    summaries.push(`${turn.tool}: ${turn.summary}`);
  }
  return summaries.reverse();
}

/**
 * v2.5 (Phase A). Walk the session backwards and
 * collect the trailing `user` / `assistant_reply` rows in
 * chronological order. Excludes the just-arrived user message
 * (matched against `currentUserMessage`) so the rewriter's history
 * never contains the message it is being asked to rewrite. The cap
 * is intentionally generous so a long-context decorator (e.g. a
 * future segmentation-aware rewriter) can use a wider window without
 * a second pass.
 */
const RECENT_TURN_PROJECTION_CAP = 12;

function collectRecentUserAssistantTurns(
  state: SessionState,
  currentUserMessage: string | undefined,
): { role: "user" | "assistant"; text: string }[] {
  const rows: { role: "user" | "assistant"; text: string }[] = [];
  for (
    let i = state.turns.length - 1;
    i >= 0 && rows.length < RECENT_TURN_PROJECTION_CAP;
    i -= 1
  ) {
    const turn = state.turns[i];
    if (!turn) continue;
    if (turn.kind === "user") {
      // Skip the trailing user row that mirrors `currentUserMessage`
      // — the rewriter consumes that via `MemoryContextProviderInput.userMessage`.
      if (
        rows.length === 0 &&
        currentUserMessage !== undefined &&
        turn.text === currentUserMessage
      ) {
        continue;
      }
      rows.push({ role: "user", text: turn.text });
    } else if (isFinalReplyTurn(turn) && !isStoppedTurnMarker(turn)) {
      // A stop marker is not something the agent said; the rewriter
      // reads this list as the conversation.
      rows.push({ role: "assistant", text: turn.text });
    }
  }
  return rows.reverse();
}

export function createSurfacedMemoryTracker(state: SessionState) {
  // Memory-v2 phase 6 — accumulate the union of lesson ids surfaced
  // across every step of this turn. `refreshMemoryContext` may
  // recompute `state.recalledLessons` per step; we record each new
  // id as it lands so the lifecycle hook fires once-per-turn-per-id
  // even when the same lesson keeps re-surfacing.
  const surfacedLessonIds = new Set<number>();
  const recordSurfacedLessons = (s: SessionState): void => {
    for (const l of s.recalledLessons ?? []) {
      surfacedLessonIds.add(l.id);
    }
  };
  recordSurfacedLessons(state);
  // Memory-v2 phase 7b — same accumulator, but for procedure ids.
  // Surfaces into the vote-runner allowlist so the LLM can only
  // vote on procedures it actually saw in `### procedures`.
  const surfacedProcedureIds = new Set<number>();
  const recordSurfacedProcedures = (s: SessionState): void => {
    for (const p of s.recalledProcedures ?? []) {
      surfacedProcedureIds.add(p.id);
    }
  };
  recordSurfacedProcedures(state);
  // Memory-v2 phase 2 — same accumulator again, this time for the
  // freeform note ids that feed `recalledMemoryIds` below. Reading
  // `state.recalledNotes` at reflection time instead was a silent
  // no-op on every multi-step turn: by the last step the recall
  // query has drifted into tool-output noise and returns nothing, so
  // the link-generator was handed an empty allowlist and skipped.
  const surfacedNoteIds = new Set<number>();
  const recordSurfacedNotes = (s: SessionState): void => {
    for (const n of s.recalledNotes ?? []) {
      surfacedNoteIds.add(n.id);
    }
  };
  recordSurfacedNotes(state);
  return {
    surfacedLessonIds,
    surfacedProcedureIds,
    surfacedNoteIds,
    recordSurfacedLessons,
    recordSurfacedProcedures,
    recordSurfacedNotes,
  };
}
