import type { SessionStore } from "../../session/session-store.js";
import { INTERRUPTED_TURN_ENDING } from "../../session/session-store.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { SteeringInbox } from "../steering-inbox.js";
import type { ShellJobRegistry } from "../../tools/os/shell/shell-jobs.js";
import type { ReflectionRunner } from "../../memory/reflection/index.js";
import { SHUTDOWN_TURN_GRACE_MS, type TurnsInFlight } from "../turns-in-flight.js";
import type { BrowserBackend } from "../../tools/browser/browser-backend.js";
import type { ProfileStore } from "../../memory/profile-store.js";
import type { MemoryStore } from "../../memory/memory-store.js";
import type { LessonStore } from "../../memory/lessons/lesson-store.js";
import type { ProcedureStore } from "../../memory/procedures/procedure-store.js";
import type { TaskStore } from "../../tasks/task-store.js";
import type { Scheduler } from "../../scheduler/scheduler.js";
import type { ConsolidatorJob } from "../../memory/consolidator/consolidator-job.js";
import type { McpManager } from "../../mcp/mcp-manager.js";
import type { TelegramChannel } from "../../channels/telegram/telegram-channel.js";
import type { DiscordChannel } from "../../channels/discord/discord-channel.js";
import type { SwarmRegistry } from "../../channels/swarm/swarm-registry.js";
import type { AnalyticsClient } from "../../analytics/analytics-client.js";
import type { SentryClient } from "../../error-reporting/sentry-client.js";

export interface RuntimeLifecycleResources {
  readonly sessionStore: Pick<SessionStore, "releaseOwnTurns" | "close">;
  readonly logger: Pick<StructuredLogger, "warn">;
  readonly steeringInbox: Pick<SteeringInbox, "clearAll">;
  readonly shellJobs: Pick<ShellJobRegistry, "endAll">;
  readonly reflectionRunner: Pick<ReflectionRunner, "abortPending"> | undefined;
  readonly pendingSessionNamings: Set<AbortController>;
  readonly turnsInFlight: Pick<TurnsInFlight, "settleCancelled">;
  readonly browserBackend: Pick<BrowserBackend, "shutdown">;
  readonly mcpManager: Pick<McpManager, "shutdown">;
  readonly profileStore: Pick<ProfileStore, "close">;
  readonly notesStore: Pick<MemoryStore, "close">;
  readonly lessonStore: Pick<LessonStore, "close">;
  readonly procedureStore: Pick<ProcedureStore, "close">;
  // These handles are connected after this owner is constructed. Bootstrap supplies
  // getters so shutdown reads them at their original points, rather than capturing null.
  readonly scheduler: Pick<Scheduler, "stop"> | null;
  readonly telegramChannelForShutdown: Pick<TelegramChannel, "stop"> | null;
  readonly discordChannelForShutdown: Pick<DiscordChannel, "stop"> | null;
  readonly swarmForShutdown: Pick<SwarmRegistry, "stopAll"> | null;
  readonly consolidatorJob: Pick<ConsolidatorJob, "stop"> | null;
  readonly taskStore: Pick<TaskStore, "close">;
  readonly analytics: Pick<AnalyticsClient, "shutdown"> | null;
  readonly errorReporter: Pick<SentryClient, "shutdown"> | null;
}

/** Owns shutdown state and the existing ordered teardown, including its bounded grace. */
export function createRuntimeLifecycle(resources: RuntimeLifecycleResources) {
  const { sessionStore, logger, steeringInbox, shellJobs, reflectionRunner,
    pendingSessionNamings, turnsInFlight, browserBackend, mcpManager,
    profileStore, notesStore, lessonStore, procedureStore } = resources;
  /**
   * Record every turn this runtime still has marked `running` as
   * interrupted. Shutdown only: by then a turn that has not written its
   * end cannot be counted on to, and a row left `running` would show a
   * turn nothing is running until some later boot cleans it up.
   * `keepMarks` writes it as a stand-in the turn's own end can still
   * replace (`SessionStore.releaseOwnTurns`).
   */
  const releaseTurnsInterrupted = (
    options: { keepMarks?: boolean } = {},
  ): void => {
    try {
      sessionStore.releaseOwnTurns(INTERRUPTED_TURN_ENDING, options);
    } catch (err) {
      logger.warn("could not record the turns this shutdown interrupted", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  let shutdownCalled = false;
  const shutdown = async (): Promise<void> => {
    if (shutdownCalled) return;
    shutdownCalled = true;
    // Say now, while the store is certainly open, that the turns still
    // running were interrupted: a stop that turns into a kill partway
    // through this teardown — the desktop gives it 4 s — still leaves
    // every row right. It goes in as a stand-in: a turn that writes its
    // own end before the store closes (below), or that throws and ends
    // through `releaseTurn`, replaces it with what really happened.
    releaseTurnsInterrupted({ keepMarks: true });
    // No scheduled turn may start on a runtime that is closing: the
    // ticker stops here. The tick already running — and the task turn in
    // it, which nothing stops — is waited for further down, where it
    // always was.
    const schedulerStopped = resources.scheduler?.stop().catch((err: unknown) => {
      logger.warn("scheduler stop failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    // Nothing will drain the inbox after this point; drop pending
    // steers so a message cannot resurface in a later process.
    steeringInbox.clearAll();
    // Every detached shell job, kept or not: nothing will wait on it
    // once this process is gone, and its ceiling timer dies with us.
    shellJobs.endAll();
    // Cancel any in-flight reflection before tearing down the profile
    // store — otherwise a late-arriving completion could try to write
    // into a closed SQLite connection.
    try {
      reflectionRunner?.abortPending();
    } catch {
      // runner already disposed
    }
    // Same race, same reason, for session naming (`pendingSessionNamings`).
    for (const naming of pendingSessionNamings) naming.abort();
    pendingSessionNamings.clear();
    if (resources.telegramChannelForShutdown) {
      try {
        await resources.telegramChannelForShutdown.stop();
      } catch (err) {
        logger.warn("telegram: shutdown failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (resources.discordChannelForShutdown) {
      try {
        // Stops the gateway, aborts in-flight turns and releases the
        // single-instance lock. Runs alongside the Telegram teardown,
        // before the LLM client goes away.
        await resources.discordChannelForShutdown.stop();
      } catch (err) {
        logger.warn("discord: shutdown failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (resources.swarmForShutdown) {
      try {
        await resources.swarmForShutdown.stopAll();
      } catch (err) {
        logger.warn("swarm: shutdown failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      // MCP manager closes every connected `McpClient` (transport
      // + sampling handler) and clears the dynamic resource-class
      // resolver. Best-effort: per-server close errors are
      // swallowed inside the manager.
      await mcpManager.shutdown();
    } catch (err) {
      logger.warn("mcp: shutdown failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await browserBackend.shutdown();
    } catch (err) {
      logger.warn("browser shutdown failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // The turns their hosts stopped — `serve`'s dropped connections, the
    // TUI's and the sidecar's aborts, the channels above — are unwinding
    // now. Closing the store under them is how a turn cancelled by a quit
    // used to lose its end: it saved a moment after `close`, and its row
    // kept what it held before the turn. Give them a moment first; a
    // turn nobody stopped (a scheduled task) is not waited for.
    const stillEnding = await turnsInFlight.settleCancelled(
      SHUTDOWN_TURN_GRACE_MS,
    );
    if (stillEnding > 0) {
      logger.warn("stopped turns still running at shutdown; recorded as interrupted", {
        count: stillEnding,
      });
    }
    // A turn that did not end in time, or that started after the release
    // at the top, is recorded the same way before the store goes away.
    releaseTurnsInterrupted();
    try {
      sessionStore.close();
    } catch {
      // already closed
    }
    try {
      profileStore.close();
    } catch {
      // already closed
    }
    try {
      // Memory-v2 phase 5. LessonStore owns its own SQLite handle on
      // the same `memory.sqlite` file as MemoryStore / ProfileStore /
      // LinkStore — close before letting the process exit so WAL
      // checkpointing finishes cleanly.
      lessonStore.close();
    } catch {
      // already closed
    }
    try {
      // Memory-v2 phase 7b. ProcedureStore owns its own SQLite
      // handle on the same `memory.sqlite` file. Close it before
      // notesStore so all derived stores release their connection
      // pre-WAL checkpoint.
      procedureStore.close();
    } catch {
      // already closed
    }
    try {
      notesStore.close();
    } catch {
      // already closed
    }
    // Stopped at the top; this waits out the tick that was running then.
    await schedulerStopped;
    if (resources.consolidatorJob) {
      try {
        await resources.consolidatorJob.stop();
      } catch (err) {
        logger.warn("consolidator stop failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      resources.taskStore.close();
    } catch {
      // already closed
    }
    // Flush any queued analytics events before the process exits.
    // Fire-safe: `shutdown()` swallows its own errors.
    if (resources.analytics) {
      await resources.analytics.shutdown();
    }
    // Flush any queued error reports before the process exits.
    if (resources.errorReporter) {
      await resources.errorReporter.shutdown();
    }
  };

  return { shutdown, isShutdown: () => shutdownCalled };
}
