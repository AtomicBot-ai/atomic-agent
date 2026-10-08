import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AtomicAgentConfig } from "../../config/index.js";
import { SessionStore, createEmptySessionState, createFusionWorkerSession, pruneSessions, readSessionPins, type FusionWorkerMeta, type SessionState } from "../../session/index.js";
import { WEBHOOK_SESSIONS_FILENAME } from "../../http/webhook-session-store.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ShellJobRegistry } from "../../tools/os/shell/shell-jobs.js";
import type { createRuntimeTraces } from "./runtime-traces.js";

export function prepareRuntimeSessionStore(
  config: AtomicAgentConfig,
  logger: StructuredLogger,
) {
  // Constructed before the tool registry: `os.fs.locate_project`
  // (issue #77) reads recent-session working dirs through the
  // column-only `listRecentWorkingDirs` projection, so the store must
  // exist by the time `registerOsTools` wires the closure below.
  const sessionStore = new SessionStore();
  if (sessionStore.turnMarksUnavailable !== null) {
    // The first open after an upgrade adds the `turn_owner` column, and
    // could not this time. The runtime runs without turn marks — as it
    // did before they existed — and the next start tries again.
    logger.warn("session turn marks unavailable for this run", {
      error: sessionStore.turnMarksUnavailable,
    });
  }
  // A row still marked `running` by a process that is gone is a turn that
  // will never write its end — the app was killed or crashed mid-turn —
  // and every list would show it running for ever. End those before
  // anything reads the table (the retention pass below included: it
  // never prunes a live row, so a ghost would also be kept for ever).
  // Rows a live process still owns — a second window, a `serve` beside a
  // TUI — are left alone. Never blocks boot.
  try {
    const recovered = sessionStore.recoverInterruptedTurns();
    if (recovered.length > 0) {
      logger.info("sessions left mid-turn by a stopped agent marked cancelled", {
        count: recovered.length,
        sessionIds: recovered.join(","),
      });
    }
  } catch (err) {
    logger.warn("could not end sessions left mid-turn; continuing", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // `sessions.sqlite` and the traces beside it are the only state this
  // runtime never shrinks (§"Session retention"). One bounded pass here,
  // opt-in, and wrapped so that a prune can never be the reason a
  // runtime fails to start — a retention pass that throws costs the
  // operator nothing but disk.
  if (config.sessions.retention.enabled) {
    try {
      const pruned = pruneSessions({
        db: sessionStore.getDatabaseHandleForRetention(),
        maxAgeDays: config.sessions.retention.maxAgeDays,
        maxRows: config.sessions.retention.maxRows,
        tracesDir: config.paths.tracesDir,
        // Read here, not inside the prune: what points at a session is
        // this runtime's knowledge, and both files are read before the
        // stores that own them exist (the task queue and the webhook
        // map are both built hundreds of lines below).
        keepSessionIds: readSessionPins({
          tasksDbFile: config.paths.tasksDbFile,
          webhookSessionsFile: resolve(
            config.paths.stateDir,
            WEBHOOK_SESSIONS_FILENAME,
          ),
        }),
      });
      // Nothing on a no-op: an install inside its retention window would
      // otherwise log a line every boot saying it did nothing.
      if (pruned.deleted > 0) {
        logger.info("pruned sessions past retention", {
          ...pruned,
          maxAgeDays: config.sessions.retention.maxAgeDays,
          maxRows: config.sessions.retention.maxRows,
        });
      }
    } catch (err) {
      logger.warn("session retention pass failed; continuing", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return sessionStore;
}

export function installRuntimeSessionDelete(
  sessionStore: Pick<SessionStore, "delete">,
  dropRecorder: ReturnType<typeof createRuntimeTraces>["dropRecorder"],
  shellJobs: Pick<ShellJobRegistry, "endSession">,
) {
  // Drop a session's trace recorder — and stop its detached shell jobs,
  // kept ones included — when the session itself is deleted, so the map
  // shrinks on teardown instead of relying on the cap to push entries
  // out. Wrapped here rather than at each call site (the TUI and the
  // HTTP route both delete sessions) so every caller gets it.
  const deleteSession = sessionStore.delete.bind(sessionStore);
  sessionStore.delete = (id: string): void => {
    dropRecorder(id);
    shellJobs.endSession(id);
    deleteSession(id);
  };


}

export function createRuntimeSessionFactories(
  workingDir: string,
  sessionStore: Pick<SessionStore, "save">,
  ensureRecorder: ReturnType<typeof createRuntimeTraces>["ensureRecorder"],
) {
  const createSession = (
    input: { metadata?: Record<string, unknown>; persist?: boolean } = {},
  ): SessionState => {
    const state = createEmptySessionState({
      id: `s-${randomUUID()}`,
      workingDir,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    // Deferred: the first turn writes the row and opens the recorder, so
    // an allocation nobody speaks to leaves nothing behind — neither a
    // row nor a trace file. See `AgentRuntime.createSession`.
    if (input.persist === false) return state;
    sessionStore.save(state);
    ensureRecorder(state);
    return state;
  };

  // In memory only: no `sessionStore.save`, no `ensureRecorder`. The
  // worker stamp is what `executeTurn` keys its skips on.
  const createEphemeralSession = (meta: FusionWorkerMeta, inheritedDir?: string): SessionState => ({
    ...createFusionWorkerSession({ workingDir: inheritedDir ?? workingDir, meta }),
    ...(inheritedDir !== undefined ? { inheritedWorkspace: true } : {}),
  });

  return { createSession, createEphemeralSession };
}
