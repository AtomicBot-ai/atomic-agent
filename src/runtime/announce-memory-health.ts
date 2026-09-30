import type { AgentLoopEvent } from "../agent/agent-loop.js";
import {
  createSubcallHealthTracker,
  type MemorySubcallKind,
  type MemorySubcallOutcome,
  type SubcallHealthTracker,
} from "../memory/health/index.js";
import type {
  VoteRunner,
  VoteTraceEvent,
} from "../memory/voting/vote-runner.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";
import type { TraceRecorder } from "../tracing/trace/trace-recorder.js";

export interface MemoryHealthAnnouncer {
  /**
   * Fold one sub-call outcome in. Fire-safe: it is called from inside
   * the runners' trace hooks, and a broken sink must never cost the
   * sub-call that reported.
   */
  observe(
    sessionId: string,
    kind: MemorySubcallKind,
    outcome: MemorySubcallOutcome,
    reason?: string,
  ): void;
}

/**
 * Turns the tracker's once-per-(session, kind) warning into the three
 * places an operator looks: a warn log line, and a
 * `memory_health_warning` event on the session — which the trace
 * recorder writes as a row and the TUI renders as a warn notice.
 *
 * `emit` takes the session explicitly (bootstrap's
 * `emitAgentLoopEventFor`): reflection settles after the turn ended, and
 * the event must land on the session the sub-call ran for.
 */
export function createMemoryHealthAnnouncer(deps: {
  emit: (sessionId: string, event: AgentLoopEvent) => void;
  logger?: Pick<StructuredLogger, "warn">;
  tracker?: SubcallHealthTracker;
}): MemoryHealthAnnouncer {
  const tracker = deps.tracker ?? createSubcallHealthTracker();
  return {
    observe(sessionId, kind, outcome, reason) {
      try {
        const warning = tracker.record({
          sessionId,
          kind,
          outcome,
          ...(reason ? { reason } : {}),
        });
        if (warning === null) return;
        deps.logger?.warn("memory.health.warning", {
          sessionId,
          kind: warning.kind,
          outcome: warning.outcome,
          consecutive: warning.consecutive,
          setting: warning.setting,
          ...(warning.reason !== undefined ? { reason: warning.reason } : {}),
        });
        deps.emit(sessionId, { type: "memory_health_warning", ...warning });
      } catch {
        // Observability must never derail the sub-call — swallow.
      }
    },
  };
}

/**
 * The vote trace sink, shared by `VoteRunner` and the vote-aware
 * reflection decorator. It lives here rather than inline in bootstrap
 * because the two branches below are the whole of the wiring that
 * decides whether a vote turn is observable at all, and inline in
 * `createAgentRuntime` nothing could reach them.
 *
 * Which branch folds health is the load-bearing part. The runner's own
 * outcomes reach the tracker through `observeVoteRunnerHealth` (it
 * reads `run()`'s result), so folding the per-vote `applied` /
 * `rejected` rows in here too would count the same turn twice. The
 * decorator's `run` rows are the opposite case: they bail out before
 * `run()` and have no result for `observeVoteRunnerHealth` to read, so
 * this is the only place they can be folded — including for a session
 * with tracing off, which is why the health call sits outside the
 * recorder check.
 */
export function createVoteTraceSink(deps: {
  /**
   * Per-session recorder lookup (bootstrap's `touchRecorder`).
   * Reflection and voting fire fire-and-forget after `turn_finished`,
   * so `undefined` is the normal "tracing disabled for this session"
   * outcome, not an error.
   */
  resolveRecorder: (sessionId: string) => TraceRecorder | undefined;
  health: MemoryHealthAnnouncer;
}): (event: VoteTraceEvent) => void {
  return (event: VoteTraceEvent) => {
    const recorder = deps.resolveRecorder(event.sessionId);
    if (event.type === "run") {
      recorder?.recordVote({
        outcome: event.outcome,
        ...(typeof event.candidates === "number"
          ? { candidates: event.candidates }
          : {}),
        reason: event.reason,
      });
      deps.health.observe(event.sessionId, "vote", event.outcome, event.reason);
      return;
    }
    if (!recorder) return;
    if (event.type === "applied") {
      recorder.recordVoteApplied({
        kind: event.kind,
        targetId: event.targetId,
        direction: event.direction,
        score: event.score,
        clampHit: event.clampHit,
      });
    } else {
      recorder.recordVoteRejected({
        kind: event.kind,
        targetId: event.targetId,
        direction: event.direction,
        reason: event.reason,
      });
    }
  };
}

/**
 * The vote runner reports its outcome only in `run()`'s result (its
 * trace hook covers individual votes), so its health is read there.
 * Everything else passes through untouched.
 */
export function observeVoteRunnerHealth(
  runner: VoteRunner,
  announcer: MemoryHealthAnnouncer,
): VoteRunner {
  return {
    async run(input) {
      const result = await runner.run(input);
      announcer.observe(input.sessionId, "vote", result.outcome, result.reason);
      return result;
    },
    abortPending(options) {
      runner.abortPending(options);
    },
  };
}
