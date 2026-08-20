import { homedir } from "node:os";
import { join } from "node:path";

import type { ProfileFact } from "../memory/profile-store.js";
import type { SkillCatalogEntry } from "../prompt/stable-prefix.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import {
  isFailedSessionStatus,
  type SessionState,
} from "../session/session-state.js";
import { checkForAppUpdate, runAppUpdate, canSelfUpdate } from "../update/index.js";
import { clearTtyScreen } from "./clear-tty-screen.js";
import {
  DetachedTurns,
  droppedPreview,
  formatBackgroundTurnFailed,
  formatBackgroundTurnFinished,
  formatDetachedTurnNotice,
  formatDroppedQueueOnSwitchNotice,
  formatDroppedSteersNotice,
  formatReplayGapNotice,
  SWITCHED_AWAY_APPROVAL_REASON,
  TurnEventBuffer,
} from "./detached-turns.js";
import { captureAndWriteDebugBundle } from "./debug-bundle/index.js";
import { LlmHealthPoller } from "./llm-health/llm-health-poller.js";
import { LocalModelsOrchestrator } from "./local-models/local-models-orchestrator.js";
import { TasksOrchestrator } from "./tasks/tasks-orchestrator.js";
import { SkillsOrchestrator } from "./skills/skills-orchestrator.js";
import { MemoryOrchestrator } from "./memory/memory-orchestrator.js";
import { McpOrchestrator } from "./mcp/mcp-orchestrator.js";
import { ImportOrchestrator } from "./import/import-orchestrator.js";
import { ProvidersOrchestrator } from "./providers/providers-orchestrator.js";
import { FallbackOrchestrator } from "./llm-panel/fallback/fallback-orchestrator.js";
import { TuiTelegramOrchestrator } from "./telegram/tui-telegram-orchestrator.js";
import { PrivacyOrchestrator } from "./privacy/privacy-orchestrator.js";
import type { TuiEventBus } from "./tui-app.js";
import { formatAgentErrorForChat } from "./format-agent-error-for-chat.js";
import {
  ChatPullMirror,
  evaluateLocalTurnGate,
  readLocalTurnGateFacts,
  type LocalTurnGateFacts,
} from "./local-turn-gate.js";
import { turnsToMessages } from "./turns-to-messages.js";
import { createHeapGuard } from "../runtime/heap-guard.js";
import type { SessionPickerEntry, TuiState } from "./tui-state.js";

const DEBUG_BUNDLE_TRACE_LIMIT = 10;
const DEBUG_BUNDLE_DIR_NAME = "atomic-agent-debug";

/**
 * Hard cap on messages parked behind the running turn.
 *
 * Nothing bounded this before because nothing could reach it: the editor
 * was dead for the duration of a turn, so the queue was a de-facto
 * zero-length buffer. Now that typing stays live, a leaned-on Enter or a
 * multi-line paste can pile up an arbitrary backlog, and every parked
 * message is later replayed as a full `runTurn` — an unbounded queue is
 * an unattended agent run nobody asked for.
 *
 * Twenty is past any backlog a human types while watching one turn
 * stream, small enough that draining it stays comprehensible, and it
 * keeps `emitQueue`'s whole-array copy bounded at 20 elements per push.
 */
export const MAX_QUEUED_MESSAGES = 20;

export interface ChatOrchestratorOptions {
  maxSteps: number;
  /** Initial llama-server base URL for the footer health poller. */
  llamaUrl: string;
  /**
   * Facts source for the pre-turn local-model gate. Injectable so tests
   * stay hermetic — the default reads live config + disk, and a test
   * that never passes this would silently depend on the developer's own
   * `~/.atomic-agent` state.
   */
  readGateFacts?: () => LocalTurnGateFacts;
}

/** Multiline text for the chat transcript (`/memory`); feed still gets `runtime_info` lines. */
function formatProfileSystemMessage(facts: readonly ProfileFact[]): string {
  if (facts.length === 0) {
    return "user profile: (empty) — use memory.profile.set to record cross-session facts";
  }
  const sorted = [...facts].sort((a, b) => a.key.localeCompare(b.key));
  const header = `user profile (${sorted.length} fact${sorted.length === 1 ? "" : "s"})`;
  const lines = sorted.map((f) => `  - ${f.key}: ${f.value}`);
  return [header, ...lines].join("\n");
}

/** Multiline text for the chat transcript (`/skills`); feed still gets `runtime_info` lines. */
function formatSkillCatalogSystemMessage(
  catalog: readonly SkillCatalogEntry[],
): string {
  if (catalog.length === 0) {
    return "skill catalog: (none installed)";
  }
  const header = `skill catalog (${catalog.length} entr${catalog.length === 1 ? "y" : "ies"})`;
  const lines = catalog.map(
    (e) => `  - ${e.name} (${e.source}): ${e.description}`,
  );
  return [header, ...lines].join("\n");
}

/**
 * Owns the single live chat session. Each call to `sendMessage` queues a
 * macro-turn through `runtime.runTurn`; only one turn is in flight at any
 * time so the user can keep typing without racing the agent loop. Abort
 * cancels the current turn and discards whatever is parked behind it,
 * but keeps the session alive — that is what sets chat mode apart from
 * the legacy goal-runner.
 *
 * The Tasks tab surface (list/detail/create/cancel/run-now) is delegated
 * to `TasksOrchestrator`, which is constructed here and exposed via
 * `tasks` so `tui-command.ts` can wire its callbacks without reaching
 * into runtime internals.
 */
export class ChatOrchestrator {
  private session: SessionState | null = null;
  private currentController: AbortController | null = null;
  private quitting = false;
  private started = false;
  /** Latest release version captured by `checkForUpdate`, used by `runUpdate`. */
  private pendingUpdateVersion: string | null = null;
  private readonly queue: string[] = [];
  /**
   * Messages refused since the queue last had room, so a burst reads as
   * one escalating counter instead of N identical lines. Reset by the
   * first push that fits again.
   */
  private droppedWhileFull = 0;
  /**
   * How many leading `queue` entries are steering re-routes for the turn
   * currently in flight. New re-routes are spliced in at this index, so
   * they stay ahead of ordinary backlog (they are corrections to the turn
   * the operator is watching) while keeping their own typing order. Reset
   * whenever a turn starts — a message aimed at the previous turn is
   * ordinary backlog from the next one's point of view.
   */
  private steeredAhead = 0;
  /**
   * Abort handles of turns the operator switched away from — see
   * `detachRunningTurn`. Switching back re-attaches the handle; quit
   * aborts everything still parked here.
   */
  private readonly detachedTurns = new DetachedTurns();
  /**
   * Rolling log of the agent events emitted by this orchestrator's
   * running turns, keyed by session — what a switch-back replays so a
   * re-attached thread shows its own prompt and feed instead of the
   * empty stored snapshot. Fed by the bus tap in the constructor,
   * started per turn in `runOneTurn`, dropped when the turn ends.
   */
  private readonly turnEvents = new TurnEventBuffer();
  /**
   * Guards the bus tap against recording its own replay — without it a
   * second switch-back would replay every event twice.
   */
  private replayingTurnEvents = false;
  /**
   * The visible turn was re-attached by a switch-back mid-run. While
   * the operator was away its events were dropped (the reducer filters
   * by visible session), so when it finishes the transcript is
   * re-emitted from the saved session instead of trusting the stream.
   */
  private reattachedMidTurn = false;
  /**
   * Live view of the model/backend pull the reducer also tracks
   * (`localModelsPanel.pull`), fed from the same bus events. The
   * pre-turn gate reads it to print real percent + bytes instead of a
   * bare "not downloaded" while the fix is already in flight.
   */
  private readonly chatPull = new ChatPullMirror();
  public exitCode = 0;
  public readonly tasks: TasksOrchestrator;
  public readonly skills: SkillsOrchestrator;
  public readonly memory: MemoryOrchestrator;
  public readonly mcp: McpOrchestrator;
  public readonly import: ImportOrchestrator;
  public readonly providers: ProvidersOrchestrator;
  public readonly fallback: FallbackOrchestrator;
  public readonly localModels: LocalModelsOrchestrator;
  public readonly llmHealth: LlmHealthPoller;
  public readonly telegram: TuiTelegramOrchestrator;
  public readonly privacy: PrivacyOrchestrator;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
    private readonly options: ChatOrchestratorOptions,
  ) {
    this.tasks = new TasksOrchestrator(runtime, bus, {
      getCurrentSessionId: () => this.session?.id ?? null,
      switchSession: (id) => this.switchSession(id),
    });
    this.skills = new SkillsOrchestrator(runtime, bus);
    this.memory = new MemoryOrchestrator(runtime, bus);
    this.mcp = new McpOrchestrator(runtime, bus);
    this.import = new ImportOrchestrator(runtime, bus, {
      refreshTasks: () => this.tasks.refresh(),
    });
    this.providers = new ProvidersOrchestrator(runtime, bus);
    this.fallback = new FallbackOrchestrator(bus);
    this.llmHealth = new LlmHealthPoller(bus, options.llamaUrl);
    this.localModels = new LocalModelsOrchestrator(bus, {
      onManagedModelSelected: (modelId) => {
        this.llmHealth.notifyCatalogModel(modelId);
      },
      onManagedDaemonRestarted: () => {
        void this.llmHealth.refreshModelLabel();
      },
      onManagedModelActivated: () => {
        // The operator put a model live and it actually serves — the
        // local equivalent of a verified cloud key. Deliberately NOT on
        // `onManagedDaemonRestarted`: that also fires from the
        // launch-time `autoStartIfReady`, which would report an ordinary
        // app start as a first-time setup. `llama.cpp` is the runner,
        // never the model id — a local model name is an arbitrary
        // operator string.
        runtime.reportModelConfigured("llama.cpp", "local");
      },
    });
    this.telegram = new TuiTelegramOrchestrator(runtime, bus);
    this.privacy = new PrivacyOrchestrator(runtime, bus);
    // Tap the bus rather than the runtime handler: what the reducer was
    // offered is exactly what a switch-back may need to replay, session
    // tags included. `record` no-ops for sessions without a running
    // TUI turn, so scheduler/HTTP-origin events cost one Map miss.
    bus.subscribe((action) => {
      if (this.replayingTurnEvents) return;
      if (action.type !== "agent_event" || action.sessionId === undefined) {
        return;
      }
      this.turnEvents.record(action.sessionId, action.event);
    });
    this.chatPull.attach(bus);
  }

  /**
   * Boots the long-running side-channels (LLM health poller, Telegram
   * channel, recent-sessions sidebar) but **does not** allocate a chat
   * session — that is deferred to the first `sendMessage` so opening
   * the TUI to glance at sessions / settings does not litter the store
   * with empty rows. `newSession()` and `sendMessage()` are the only
   * paths that mint a fresh `SessionState`.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.refreshRecentSessions();
    this.llmHealth.start();
    this.telegram.start();
    this.privacy.refresh();
    // Boot the tasks orchestrator on TUI mount so the always-on
    // sidebar's Tasks pane has fresh data without waiting for the
    // operator to open the Tasks debug tab. Idempotent — opening the
    // Tasks tab later just re-uses the same interval.
    this.tasks.startAutoRefresh();
  }

  /**
   * Allocates a fresh `SessionState` if none is active yet and notifies
   * listeners. Idempotent — callers can invoke before any operation
   * that needs a live session id (`sendMessage`, opening the working
   * dir for skill scripts, …).
   */
  private ensureSession(): SessionState {
    if (this.session) return this.session;
    this.session = this.runtime.createSession();
    this.bus.emit({ type: "session_created", sessionId: this.session.id });
    this.refreshRecentSessions();
    return this.session;
  }

  /** Update the llama-server URL tracked by the footer health poller. */
  updateLlamaUrl(nextUrl: string): void {
    this.llmHealth.updateUrl(nextUrl);
  }

  /**
   * Fire-and-forget startup version check. When GitHub Releases report a
   * newer version (and the running binary can self-update), emit
   * `update_available` so the TUI can offer the in-app update. Any
   * failure (offline, rate-limited, dev build) is swallowed — the check
   * must never disturb a normal launch.
   */
  async checkForUpdate(): Promise<void> {
    if (!this.runtime.config.update.checkOnStartup) return;
    if (!canSelfUpdate()) return;
    try {
      const result = await checkForAppUpdate({
        repo: this.runtime.config.update.repo,
      });
      if (!result.updateAvailable) return;
      this.pendingUpdateVersion = result.latestVersion;
      this.bus.emit({
        type: "update_available",
        current: result.currentVersion,
        latest: result.latestVersion,
      });
    } catch {
      // Silent: a failed update check is never user-facing noise.
    }
  }

  /**
   * Run the canonical installer (`install.sh` on POSIX, `install.ps1` on
   * Windows) to upgrade the installed binary in place. Streams installer
   * output to the feed and emits `update_finished` when it settles. The
   * running process is not restarted — the reducer's success message asks
   * the user to relaunch.
   */
  runUpdate(): void {
    // Replacing the binary under a running turn is the one mid-run slash
    // command with no safe outcome — now reachable because the editor
    // stays live. Refuse it instead of racing the installer.
    if (this.currentController || this.detachedTurns.size > 0) {
      this.notify(
        "update: refused while a turn is running (foreground or background) — abort it or let it finish first",
      );
      return;
    }
    this.bus.emit({ type: "update_started" });
    void (async () => {
      try {
        await runAppUpdate({
          repo: this.runtime.config.update.repo,
          onLine: (line) =>
            this.bus.emit({ type: "runtime_info", line: `[update] ${line}` }),
        });
        this.bus.emit({
          type: "update_finished",
          ok: true,
          ...(this.pendingUpdateVersion
            ? { version: this.pendingUpdateVersion }
            : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.bus.emit({ type: "update_finished", ok: false, error: message });
      }
    })();
  }

  openSessionPicker(): void {
    // Same list the rail shows. The menu's `N recent` badge counts the
    // rail's entries, so a picker with its own idea of the set would
    // open contradicting the number that advertised it.
    this.bus.emit({
      type: "session_picker_opened",
      sessions: this.railSessions(),
    });
  }

  /**
   * The rail lists threads, not allocations. A session exists the moment
   * `+ new` mints it — `runtime.createSession` persists it immediately,
   * and scheduled tasks, webhooks and Telegram all depend on that — but
   * an unnamed row is noise: it says "(empty)" until someone types, and
   * two of them are indistinguishable.
   *
   * So the list shows sessions that have been *spoken to*. The catch is
   * timing: the first user turn only reaches SQLite when the whole turn
   * finishes (`executeTurn` saves after the loop returns), so a
   * store-backed refresh at prompt time still sees nothing. These
   * entries bridge that window with a row built from the submitted
   * text, each retiring as soon as the store can answer for its id.
   *
   * A map, not a single slot: with a turn detached in the background,
   * the NEXT thread's first prompt would otherwise evict the detached
   * thread's stand-in — making the one session the operator most needs
   * to find again invisible in the rail and the picker until its turn
   * finishes. Bounded by construction: one entry per session whose
   * first turn has not been saved yet, i.e. at most the visible thread
   * plus the detached ones.
   */
  private readonly pendingRows = new Map<string, SessionPickerEntry>();

  refreshRecentSessions(): void {
    this.bus.emit({
      type: "recent_sessions_updated",
      sessions: this.railSessions(),
    });
  }

  /** Stored threads that have a first prompt, plus the pending ones. */
  private railSessions(): SessionPickerEntry[] {
    // Read deeper than we show, because the filter runs HERE and the
    // limit runs in SQL. Every `+ new` and every scheduled task mints a
    // persisted, unnamed session; filtering a 25-row window would let
    // those invisible rows squat it and push real conversations out —
    // permanently, since a thread only re-enters the window by being
    // spoken to, which you cannot do once it has no row.
    const stored = this.runtime.sessionStore
      .listRecent(RAIL_SCAN_LIMIT)
      .filter((state) => hasFirstPrompt(state))
      .map((s) => toPickerEntry(s))
      .slice(0, RAIL_SESSION_LIMIT);
    if (this.pendingRows.size === 0) return stored;
    const storedIds = new Set(stored.map((entry) => entry.sessionId));
    const pending: SessionPickerEntry[] = [];
    for (const [sessionId, entry] of this.pendingRows) {
      // The store caught up: drop the stand-in rather than render the
      // same session twice (the rail keys rows by session id).
      if (storedIds.has(sessionId)) {
        this.pendingRows.delete(sessionId);
        continue;
      }
      pending.push(entry);
    }
    // Newest stand-in first, matching the store's recency order.
    pending.reverse();
    return [...pending, ...stored];
  }

  /**
   * Put the current session on the rail the instant its first prompt is
   * sent, named by that prompt. Called from `runOneTurn`, which is the
   * one funnel every first turn passes through — `sendMessage` and
   * `steerMessage` both land there, and hooking either alone would miss
   * `/steer <text>` as an opening prompt.
   */
  private noteFirstPrompt(text: string): void {
    const session = this.session;
    if (!session) return;
    if (this.pendingRows.has(session.id)) return;
    if (hasFirstPrompt(session)) return;
    this.pendingRows.set(session.id, {
      sessionId: session.id,
      workingDir: session.workingDir,
      turnCount: 1,
      stepCount: 0,
      updatedAt: Date.now(),
      preview: text,
    });
    this.refreshRecentSessions();
  }

  /**
   * Remove a session for good, from the rail's `x` (confirmed).
   *
   * Deleting the thread the operator is *in* would leave the app
   * pointed at a row that no longer exists, so that case rolls straight
   * into a fresh session — the same landing `/new` gives. Deleting any
   * other thread only refreshes the list.
   *
   * Refused mid-turn for the same reason switching is: the running turn
   * writes its transcript back to the store when it finishes, which
   * would resurrect the row that was just deleted.
   */
  deleteSession(sessionId: string): void {
    if (this.quitting) return;
    // Scoped to the thread being deleted: a running turn elsewhere is
    // no reason to refuse. The visible controller covers the window
    // before the queued turn reaches `isBusy`; `detachedTurns` covers
    // the same window for a backgrounded one.
    if (this.currentController && this.session?.id === sessionId) {
      this.bus.emit({
        type: "system_message",
        text: "cannot delete this session while its turn is running — press Esc to stop it first",
        variant: "warn",
      });
      return;
    }
    if (this.detachedTurns.has(sessionId)) {
      this.bus.emit({
        type: "system_message",
        text: "cannot delete that session — its turn is still running in the background (switch to it and press Esc to stop it)",
        variant: "warn",
      });
      return;
    }
    // …and not only OUR turn. The same store is written by turns this
    // orchestrator never sees: a scheduled task, a Telegram message, an
    // HTTP call. Deleting a session while one of those is mid-turn does
    // not stick — `executeTurn` saves the finished session afterwards,
    // and `save()` is an upsert, so the thread reappears on the rail
    // with its whole transcript. The turn controller is the one place
    // that knows about every origin.
    if (this.runtime.turnController.isBusy(sessionId)) {
      this.bus.emit({
        type: "system_message",
        text: "cannot delete that session — a turn is running on it (a scheduled task, Telegram, or the HTTP API)",
        variant: "warn",
      });
      return;
    }
    const deletingCurrent = this.session?.id === sessionId;
    this.pendingRows.delete(sessionId);
    this.runtime.sessionStore.delete(sessionId);
    this.bus.emit({
      type: "system_message",
      text: `session deleted${deletingCurrent ? " — started a fresh one" : ""}`,
    });
    if (deletingCurrent) {
      this.newSession();
      return;
    }
    this.refreshRecentSessions();
  }

  switchSession(sessionId: string): void {
    if (this.quitting) return;
    if (this.currentController && this.session?.id === sessionId) {
      // Enter on the picker row that is already open, mid-run.
      // Re-loading would replace the live transcript with the stale
      // stored copy (a running turn saves only when it finishes), and
      // detaching first would drop the queue and deny the approval for
      // nothing — so this is a no-op, not a round-trip.
      this.bus.emit({ type: "session_picker_closed" });
      this.bus.emit({
        type: "runtime_info",
        line: `already on session ${sessionId}`,
      });
      return;
    }
    const loaded = this.runtime.sessionStore.load(sessionId);
    if (!loaded) {
      this.bus.emit({
        type: "runtime_info",
        line: `session ${sessionId} not found`,
      });
      return;
    }
    const notices = this.leaveCurrentSession();
    this.session = loaded;
    // Switching back into a thread whose turn we backgrounded earlier
    // re-attaches the abort handle: Esc aborts, Enter steers, exactly
    // as if the operator had never left.
    const resumed = this.detachedTurns.take(sessionId);
    if (resumed) {
      this.currentController = resumed;
      this.reattachedMidTurn = true;
    }
    // `isBusy` additionally catches turns from other origins (a
    // scheduled task, Telegram, HTTP) so the composer offers steer
    // instead of pretending the thread is idle.
    const running =
      resumed !== null || this.runtime.turnController.isBusy(sessionId);
    this.bus.emit({
      type: "session_switched",
      sessionId: loaded.id,
      workingDir: loaded.workingDir,
      messages: turnsToMessages(loaded.turns),
      running,
    });
    // The stored snapshot above misses everything the still-running
    // turn has said (a turn saves only when it finishes — for a thread
    // mid-first-turn the snapshot is EMPTY, prompt included). Repaint
    // from the event log before anything else lands in the transcript.
    if (resumed) this.replayTurnEvents(loaded.id);
    this.refreshRecentSessions();
    this.bus.emit({
      type: "runtime_info",
      line: `switched to session ${loaded.id} (${loaded.turnCount} turn${loaded.turnCount === 1 ? "" : "s"})${
        running ? " — a turn is still running here" : ""
      }`,
    });
    // After `session_switched`, so they land in the new transcript
    // rather than the one that was just replaced.
    for (const notice of notices) this.notify(notice);
    // A turn parked on an approval in THIS thread asked its question
    // while another transcript was on screen, where it surfaced only as
    // a pointer notice (approval keys never answer for an off-screen
    // thread). Its owner is visible now — re-raise the actual prompt.
    const parkedApproval = this.runtime.approvals.pendingRequestForSession(
      loaded.id,
    );
    if (parkedApproval) {
      this.bus.emit({ type: "approval_requested", request: parkedApproval });
    }
  }

  /**
   * Re-offer the re-attached turn's buffered events to the reducer.
   * They are tagged with the now-visible session, so they apply; live
   * events continue from where the buffer ends. When the ring cap ate
   * the head of the turn the gap is announced rather than papered over
   * — and the end-of-turn re-emit from the saved session restores the
   * authoritative transcript either way.
   */
  private replayTurnEvents(sessionId: string): void {
    const buffered = this.turnEvents.snapshot(sessionId);
    if (!buffered) return;
    this.replayingTurnEvents = true;
    try {
      if (buffered.dropped > 0) {
        this.bus.emit({
          type: "system_message",
          text: formatReplayGapNotice(buffered.dropped),
          variant: "warn",
        });
      }
      for (const event of buffered.events) {
        this.bus.emit({ type: "agent_event", event, sessionId });
      }
    } finally {
      this.replayingTurnEvents = false;
    }
  }

  /**
   * Book the visible session out before another takes its place, and
   * return the notices to show once the new transcript is up.
   *
   * With a turn in flight this is a DETACH, not an abort: the
   * concurrency contract gives every session its own FIFO and runs
   * sessions in parallel (AGENTS.md §"Concurrency contract"), so the
   * turn keeps executing against its own session and saves its
   * transcript there. What must not follow the operator to the new
   * thread:
   *
   * - the abort handle — Esc in the new thread must abort nothing;
   *   parked in `detachedTurns` and restored on switch-back;
   * - parked queue messages — aimed at the old thread; announced drop
   *   with previews, same shape as the abort path, never silent;
   * - a pending approval — the modal closes with the transcript it
   *   asks about, so the request is denied at the gate with an
   *   explicit reason; left unresolved it would park the turn forever
   *   on `await request()`;
   * - session grants — deferred, not dropped: the running turn keeps
   *   the exceptions the operator granted it, and `runOneTurn` clears
   *   them when the backgrounded turn finishes. Yanking them here
   *   would make the background turn re-prompt from off screen.
   *
   * With no turn of OURS in flight, the approval deny and the grant
   * clear still apply — scoped to the thread being left. The deny does
   * not depend on who started the turn: a scheduler/HTTP-origin turn's
   * pending approval is just as unanswerable once its transcript is
   * gone, and skipping it would park that turn forever.
   */
  private leaveCurrentSession(): string[] {
    const notices: string[] = [];
    const previous = this.session;
    if (!previous) return notices;
    // Denied for ANY pending approval on the thread being left, not
    // only when the parked turn is ours: a scheduler/HTTP/Telegram-
    // origin turn parks on the same gate, and the switch drops its
    // modal exactly the same way — left unanswered, that turn waits on
    // `await request()` forever and its session stays busy for good.
    // `denyPendingForSession` is session-scoped and a counted no-op
    // when nothing is pending.
    const denied = this.runtime.approvals.denyPendingForSession(
      previous.id,
      SWITCHED_AWAY_APPROVAL_REASON,
    );
    if (denied > 0) {
      notices.push(
        "the pending approval was denied — you switched away while it waited for an answer",
      );
    }
    if (!this.currentController) {
      this.runtime.approvals.clearSessionGrants(previous.id);
      return notices;
    }
    const dropped = [...this.queue];
    if (dropped.length > 0) {
      this.queue.length = 0;
      this.droppedWhileFull = 0;
      this.emitQueue();
      notices.push(formatDroppedQueueOnSwitchNotice(dropped));
    }
    this.steeredAhead = 0;
    this.detachedTurns.park(previous.id, this.currentController);
    this.currentController = null;
    this.reattachedMidTurn = false;
    notices.push(formatDetachedTurnNotice(previous.id));
    return notices;
  }

  dumpProfile(): void {
    try {
      const facts = this.runtime.profileStore.list();
      this.bus.emit({
        type: "system_message",
        text: formatProfileSystemMessage(facts),
      });
      if (facts.length === 0) {
        this.bus.emit({
          type: "runtime_info",
          line: "profile: (empty) — use memory.profile.set to record cross-session facts",
        });
        return;
      }
      const sorted = [...facts].sort((a, b) => a.key.localeCompare(b.key));
      this.bus.emit({
        type: "runtime_info",
        line: `profile (${sorted.length} fact${sorted.length === 1 ? "" : "s"}):`,
      });
      for (const fact of sorted) {
        this.bus.emit({
          type: "runtime_info",
          line: `  - ${fact.key}: ${fact.value}`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const line = `profile read failed: ${msg}`;
      this.bus.emit({ type: "runtime_info", line });
      this.bus.emit({ type: "system_message", text: line });
    }
  }

  /** Emit the installed skill catalog into chat + event feed (`/skills`). */
  dumpSkillCatalog(): void {
    try {
      const catalog = this.runtime.skillCatalog;
      this.bus.emit({
        type: "system_message",
        text: formatSkillCatalogSystemMessage(catalog),
      });
      if (catalog.length === 0) {
        this.bus.emit({ type: "runtime_info", line: "skills: (none installed)" });
        return;
      }
      this.bus.emit({
        type: "runtime_info",
        line: `skill catalog (${catalog.length}):`,
      });
      for (const e of catalog) {
        this.bus.emit({
          type: "runtime_info",
          line: `  - ${e.name} (${e.source}): ${e.description}`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const line = `skill catalog read failed: ${msg}`;
      this.bus.emit({ type: "runtime_info", line });
      this.bus.emit({ type: "system_message", text: line });
    }
  }

  newSession(): void {
    if (this.quitting) return;
    // A running turn keeps running in its old thread — see
    // `leaveCurrentSession`. A fresh session starts with no point
    // exceptions of its own; the previous thread's grants are cleared
    // on leave (or, if its turn is still running, when that turn ends).
    const notices = this.leaveCurrentSession();
    this.session = this.runtime.createSession();
    this.clearQueue();
    clearTtyScreen(process.stdout);
    this.bus.emit({
      type: "session_switched",
      sessionId: this.session.id,
      workingDir: this.session.workingDir,
      messages: [],
    });
    this.refreshRecentSessions();
    this.bus.emit({
      type: "runtime_info",
      line: `new session ${this.session.id} created`,
    });
    for (const notice of notices) this.notify(notice);
  }

  sendMessage(text: string): void {
    if (this.quitting) return;
    this.ensureSession();
    if (this.currentController) {
      if (this.queue.length >= MAX_QUEUED_MESSAGES) {
        this.droppedWhileFull += 1;
        // Re-publish an unchanged queue on purpose: the reducer already
        // inserted this message optimistically on `message_queued`, and
        // only an authoritative `queue_changed` takes it back off the
        // strip. Skipping the emit here would leave the operator looking
        // at a parked message that is never going to run.
        this.emitQueue();
        // The optimistic `message_queued` already cleared the editor, so
        // a refusal that only warned would lose the typed text entirely.
        // Hand it back to the buffer instead.
        this.bus.emit({ type: "input_changed", value: text });
        this.notify(
          `queue: full at ${MAX_QUEUED_MESSAGES} — dropped ${this.droppedWhileFull} message${
            this.droppedWhileFull === 1 ? "" : "s"
          } (returned to the editor); Esc stops the run, /queue clear empties it`,
        );
        return;
      }
      this.droppedWhileFull = 0;
      this.queue.push(text);
      this.emitQueue();
      return;
    }
    void this.runOneTurn(text);
  }

  /**
   * Fold a message into the turn already running on this session
   * (Enter in `steer` mode, and `/steer <msg>` one-shots).
   *
   * Steer first; on refusal the message must still go somewhere — and
   * not behind ordinary backlog: `currentController` is set strictly
   * earlier than the loop opens its window, so a refusal can mean "not
   * yet" as well as "too late" or "full". `queueAsSteer` splices it
   * ahead of backlog, behind steers already re-routed for the same
   * turn, so typing order survives. `steer`'s answer is the only fact
   * consulted — see §"Mid-turn steering" in AGENTS.md.
   */
  steerMessage(text: string): void {
    if (this.quitting) return;
    const session = this.ensureSession();
    // Offered to the inbox unconditionally: `steer`'s return value is
    // the one authoritative fact (AGENTS.md §"Mid-turn steering"), and
    // since threads stay switchable mid-run, the turn running on this
    // session is not necessarily one this orchestrator started — a
    // scheduled task's or Telegram's turn is just as steerable.
    if (this.runtime.steer(session.id, text)) {
      this.bus.emit({
        type: "runtime_info",
        line: "steering the running turn — the agent reads it at the next step",
      });
      return;
    }
    if (this.currentController) {
      if (this.queue.length >= MAX_QUEUED_MESSAGES) {
        this.droppedWhileFull += 1;
        this.emitQueue();
        this.bus.emit({ type: "input_changed", value: text });
        this.notify(
          `queue: full at ${MAX_QUEUED_MESSAGES} — the steer could not be parked (returned to the editor)`,
        );
        return;
      }
      this.droppedWhileFull = 0;
      this.queueAsSteer(text);
      this.emitQueue();
      this.bus.emit({
        type: "runtime_info",
        line: "steering the running turn — it cannot take this one, so it runs as the next turn",
      });
      return;
    }
    void this.runOneTurn(text);
  }

  /**
   * Queue a message that was meant as a steer but could not be folded
   * into the running turn — ahead of ordinary backlog, behind steers
   * already re-routed for the same turn.
   */
  private queueAsSteer(text: string): void {
    this.queue.splice(this.steeredAhead, 0, text);
    this.steeredAhead += 1;
  }

  /**
   * Re-route steering messages the turn accepted but never delivered.
   *
   * `RunTurnResult.undelivered` carries anything pushed after the loop's
   * last step boundary — during the final inference, or into a turn
   * cancelled before it stepped. AGENTS.md makes re-routing the caller's
   * job: `steer` already answered "yes" to whoever sent these, so
   * dropping them here would lose a message the operator watched being
   * accepted. They go to the FRONT of the queue — ahead of
   * `queueAsSteer`'s entries too: they are corrections aimed at the turn
   * that just ran, and anything already queued was typed after `steer`
   * had refused it.
   */
  private rerouteUndelivered(undelivered: readonly string[] | undefined): void {
    if (undelivered === undefined || undelivered.length === 0) return;
    this.queue.unshift(...undelivered);
    this.emitQueue();
    this.notify(
      `${undelivered.length} message${
        undelivered.length === 1 ? "" : "s"
      } arrived too late for that turn — sending ${
        undelivered.length === 1 ? "it" : "them"
      } next`,
    );
  }

  /**
   * Drop every parked message without touching the running turn
   * (`/queue clear`). No-op on an empty queue so the TUI is not spammed
   * with redundant `queue_changed` frames.
   */
  clearQueue(): void {
    // Even an empty queue can carry a stale steer watermark.
    this.steeredAhead = 0;
    if (this.queue.length === 0) return;
    this.queue.length = 0;
    this.emitQueue();
  }

  /**
   * Re-publish the pending-message queue to the TUI. The orchestrator is
   * the source of truth — the reducer mirrors this list rather than
   * tracking pushes and drains on its own, so an optimistic UI insert can
   * never drift from what will actually run.
   *
   * The whole-array copy is deliberate and now bounded: the action must
   * not hand subscribers a live reference to `this.queue`, and
   * `MAX_QUEUED_MESSAGES` caps the copy at 20 elements per emit. Trading
   * it for a push/shift/clear delta would put queue arithmetic back in
   * the reducer — the exact drift this design removed.
   */
  private emitQueue(): void {
    this.bus.emit({ type: "queue_changed", queued: [...this.queue] });
  }

  /**
   * Operator-facing notice about the queue: an event-feed line plus the
   * same sentence as a warn message in the transcript, because the feed
   * is not on screen in chat mode and these two events (an abort binning
   * parked work, a refused submission) are things the operator typed and
   * must not lose silently.
   */
  private notify(line: string): void {
    this.bus.emit({ type: "runtime_info", line });
    this.bus.emit({ type: "system_message", text: line, variant: "warn" });
  }

  /**
   * Issue #121: a long session was killed by the V8 heap ceiling with no
   * warning, losing ~40 minutes of work. V8 cannot raise its own ceiling
   * after startup, so the best available remedy is to say so while there
   * is still headroom to save work and restart with a bigger heap.
   * Checked at turn boundaries — the crash grew across turns, including
   * long idle gaps between them.
   */
  private readonly heapGuard = createHeapGuard();

  private announceHeapPressure(): void {
    const status = this.heapGuard.check();
    if (status?.message) this.notify(status.message);
  }

  private async runOneTurn(text: string, fromQueue = false): Promise<void> {
    if (!this.session) return;
    this.announceHeapPressure();
    // Pre-turn gate: a managed local model that is not on disk cannot
    // serve this turn, so fail fast with the real fix instead of
    // burning the transport retry budget against a daemon that cannot
    // exist. Judged at turn START (not enqueue) so a message parked
    // behind a running pull is re-checked when it actually runs. With a
    // fallback chain of >1 link the turn still runs — failing over is
    // exactly what the chain is for — and the gate only leaves a notice.
    const gate = evaluateLocalTurnGate(
      (this.options.readGateFacts ?? readLocalTurnGateFacts)(),
      this.chatPull.current,
    );
    if (gate.kind === "block") {
      if (fromQueue) {
        // A drained queue message has no editor to go back to (the
        // operator may be mid-draft), so it is dropped — announced with
        // a preview, like the abort path, never silently.
        this.bus.emit({
          type: "turn_gate_blocked",
          text: `${gate.text}\n  dropped: ${droppedPreview(text)}`,
        });
        return;
      }
      this.bus.emit({
        type: "turn_gate_blocked",
        text: `${gate.text} (message returned to the editor)`,
      });
      // Same rescue as the queue-full refusal: the optimistic submit
      // already cleared the editor, so hand the text back.
      this.bus.emit({ type: "input_changed", value: text });
      return;
    }
    if (gate.kind === "notice") this.notify(gate.text);
    // The operator can switch threads while this runs; every
    // this-session decision below re-checks against the id the turn
    // started on rather than trusting the live pointer.
    const turnSessionId = this.session.id;
    this.noteFirstPrompt(text);
    const controller = new AbortController();
    this.currentController = controller;
    // Start the replay log for this turn now, before any event lands:
    // a switch-back rebuilds the transcript from the STORE, which will
    // not carry this turn until it finishes, so the events are the only
    // way to repaint it (see `TurnEventBuffer`).
    this.turnEvents.begin(turnSessionId);
    // A new turn is in flight: whatever is still queued was aimed at an
    // earlier one and is ordinary backlog now.
    this.steeredAhead = 0;
    try {
      const result = await this.runtime.runTurn(this.session, text, {
        maxSteps: this.options.maxSteps,
        signal: controller.signal,
        origin: "tui",
      });
      const attached = this.session?.id === turnSessionId;
      // A detached turn's result must not clobber the thread the
      // operator switched to — its state is already saved to its own
      // session by `executeTurn`.
      if (attached) this.session = result.session;
      // A cancelled turn means the operator stopped the agent — Esc,
      // Ctrl+C or /abort. Re-queueing its undelivered steers here would
      // make the post-abort drain START a turn out of them: the exact
      // "Esc launches the next parked message" trap the abort path
      // exists to close. Announce the drop instead, like the queue drop.
      if (result.reason === "cancelled") {
        const dropped = result.undelivered ?? [];
        if (dropped.length > 0) {
          this.notify(
            [
              `aborted: dropped ${dropped.length} undelivered steer${dropped.length === 1 ? "" : "s"}`,
              ...dropped.map((text, i) => `  ${i + 1}. ${droppedPreview(text)}`),
            ].join("\n"),
          );
        }
      } else if (attached) {
        this.rerouteUndelivered(result.undelivered);
      } else if (result.undelivered !== undefined && result.undelivered.length > 0) {
        // Detached: the visible queue feeds another thread now, so
        // re-queueing would aim old-thread corrections at the new one.
        // Announced with previews — never silent.
        this.notify(formatDroppedSteersNotice(turnSessionId, result.undelivered));
      }
      if (isFailedSessionStatus(result.session.status)) this.exitCode = 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.session?.id === turnSessionId) {
        this.bus.emit({ type: "runtime_info", line: `turn error: ${msg}` });
        this.bus.emit({
          type: "system_message",
          text: formatAgentErrorForChat("runtime", msg),
          variant: "warn",
        });
      } else {
        // The failure belongs to a thread that is off screen; a bare
        // "turn error" would read as the visible thread's. Name it.
        this.notify(formatBackgroundTurnFailed(turnSessionId, msg));
      }
      this.exitCode = 1;
    } finally {
      if (this.currentController === controller) this.currentController = null;
      // The turn saved its session, which answers for the transcript
      // now — the replay log has nothing left to add.
      this.turnEvents.end(turnSessionId);
      if (this.detachedTurns.release(turnSessionId, controller)) {
        // End of the backgrounded turn ends its session grants — the
        // deferred half of the switch-time clear (see
        // `leaveCurrentSession`).
        this.runtime.approvals.clearSessionGrants(turnSessionId);
      }
      // The turn wrote the session back, so the stored row can now
      // answer for itself and the stand-in retires.
      this.refreshRecentSessions();
    }
    if (this.session?.id !== turnSessionId) {
      // Finished in the background: the reply is saved in its own
      // session (the rail just refreshed). The visible thread's queue
      // is not this turn's to drain.
      this.notify(formatBackgroundTurnFinished(turnSessionId));
      return;
    }
    if (this.reattachedMidTurn) {
      // Events emitted while the operator was away were dropped by the
      // reducer's session filter, so the on-screen transcript has a
      // hole where this turn's tail should be. The turn just saved
      // authoritative state — re-emit it the way a switch does.
      this.reattachedMidTurn = false;
      this.bus.emit({
        type: "session_switched",
        sessionId: turnSessionId,
        workingDir: this.session.workingDir,
        messages: turnsToMessages(this.session.turns),
      });
    }
    const next = this.queue.shift();
    // Unconditional: the idle boundary re-syncs the strip even when
    // nothing drained, so an optimistic UI insert can never outlive the
    // turn it was parked behind.
    this.emitQueue();
    if (next !== undefined && !this.quitting) {
      void this.runOneTurn(next, true);
    }
  }

  /**
   * Dump a zipped snapshot of the TUI state plus NDJSON traces for the
   * most recent sessions into `~/Documents/atomic-agent-debug/`. The
   * heavy work (readFile + zip compression) is off-thread via
   * `Promise`, but we stash the snapshot synchronously so the archive
   * reflects the exact UI state at the moment `/dump` was submitted.
   */
  exportDebugBundle(state: TuiState): void {
    const traceDir = this.runtime.config.tracing.trace.dir;
    const traceEnabled = this.runtime.config.tracing.trace.enabled === true;
    const outDir = join(homedir(), "Documents", DEBUG_BUNDLE_DIR_NAME);
    const sessionIds = this.collectDebugSessionIds();
    this.bus.emit({
      type: "runtime_info",
      line: `debug bundle: collecting ${sessionIds.length} trace${
        sessionIds.length === 1 ? "" : "s"
      } into ${outDir}`,
    });
    void (async () => {
      try {
        const result = await captureAndWriteDebugBundle({
          state,
          traceDir,
          traceEnabled,
          sessionIds,
          outDir,
        });
        this.bus.emit({
          type: "runtime_info",
          line: `debug bundle written: ${result.path} (${formatBytes(result.bytes)}, ${result.includedTraces} trace${
            result.includedTraces === 1 ? "" : "s"
          }, ${result.skippedTraces} skipped)`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.bus.emit({
          type: "runtime_info",
          line: `debug bundle failed: ${msg}`,
        });
      }
    })();
  }

  private collectDebugSessionIds(): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    if (this.session?.id) {
      ids.push(this.session.id);
      seen.add(this.session.id);
    }
    try {
      for (const s of this.runtime.sessionStore.listRecent(
        DEBUG_BUNDLE_TRACE_LIMIT,
      )) {
        if (seen.has(s.id)) continue;
        ids.push(s.id);
        seen.add(s.id);
      }
    } catch {
      // session store read failure is non-fatal — we still export the
      // snapshot plus whatever traces we already collected.
    }
    return ids.slice(0, DEBUG_BUNDLE_TRACE_LIMIT);
  }

  /**
   * Esc / Ctrl+C / `/abort` — stop the agent, not merely this turn.
   *
   * Discarding the queue is the whole point. `runOneTurn` catches the
   * abort rejection and falls straight through to `this.queue.shift()`,
   * so an intact backlog turned Esc into "start the next parked
   * message"; stopping a wrong run cost one Esc per parked message.
   * Clear first, then abort — the same order `quit()` uses below.
   *
   * The drop is announced: the operator typed those messages, so binning
   * N of them silently is worse than one line in the transcript.
   */
  abortCurrentTurn(): void {
    const dropped = [...this.queue];
    if (dropped.length > 0) {
      this.queue.length = 0;
      this.droppedWhileFull = 0;
      this.emitQueue();
      // The operator typed those messages; a bare count would bin their
      // words with no way back. The transcript line carries a preview of
      // each so anything worth keeping can be copied out.
      this.notify(
        [
          `aborted: dropped ${dropped.length} parked message${dropped.length === 1 ? "" : "s"}`,
          ...dropped.map((text, i) => `  ${i + 1}. ${droppedPreview(text)}`),
        ].join("\n"),
      );
    }
    this.currentController?.abort();
  }

  quit(): void {
    if (this.quitting) return;
    this.quitting = true;
    this.clearQueue();
    this.currentController?.abort();
    this.detachedTurns.abortAll();
  }

  async shutdown(): Promise<void> {
    this.abortCurrentTurn();
    this.detachedTurns.abortAll();
    this.tasks.shutdown();
    this.skills.shutdown();
    this.memory.shutdown();
    this.mcp.shutdown();
    this.import.shutdown();
    await this.localModels.shutdown();
    this.llmHealth.stop();
    this.telegram.shutdown();
    await this.runtime.shutdown();
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Has anyone spoken to this session? The rail and the picker list only
 * threads that have a first user turn — that turn is what gives a
 * session its name, and an unnamed row is indistinguishable from every
 * other unnamed row.
 */
/** Rows the rail and the picker show. */
const RAIL_SESSION_LIMIT = 25;
/**
 * How deep to read before filtering. Generous rather than exact: unnamed
 * sessions accumulate (one per `+ new`, one per scheduled task) and each
 * one would otherwise cost a real thread its place in the list.
 */
const RAIL_SCAN_LIMIT = 200;

function hasFirstPrompt(state: SessionState): boolean {
  return state.turns.some((turn) => turn.kind === "user");
}

function toPickerEntry(state: SessionState): SessionPickerEntry {
  const firstUser = state.turns.find((t) => t.kind === "user");
  const preview = firstUser && firstUser.kind === "user" ? firstUser.text : "";
  return {
    sessionId: state.id,
    workingDir: state.workingDir,
    turnCount: state.turnCount,
    stepCount: state.stepCount,
    updatedAt: state.updatedAt,
    preview: preview.length > 0 ? preview : "(empty)",
  };
}
