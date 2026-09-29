import {
  createEmptySessionState,
  recordTurn,
} from "../session/session-state.js";
import { userTurn } from "../session/conversation-turn.js";
import {
  summarizeSessionState,
  type SessionSummary,
} from "../session/session-summary.js";
import type { SessionSummaryPageOptions } from "../session/session-summary-page.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import { makeTuiEventBus } from "./make-event-bus.js";
import type { LocalTurnGateFacts } from "./local-turn-gate.js";
import type { TuiAction } from "./tui-action.js";
import type { SessionPickerEntry } from "./tui-state.js";

/**
 * Test harness for the session rail: a `ChatOrchestrator` over an
 * in-memory session store. Shared by `rail-session-list.test.ts` and
 * `rail-session-boot.test.ts`; not part of the app.
 */

/** Hermetic gate facts: never read the developer's real config/disk. */
export const cloudGateFacts = (): LocalTurnGateFacts => ({
  activeProviderIsLocal: false,
  managedMode: false,
  modelId: null,
  modelDownloaded: true,
  fallbackChainLength: 1,
});

/**
 * The rail lists threads that have been spoken to. A stored row with no
 * user turn is one a scheduled task or a webhook wrote — the row has to
 * exist for the id they hold — but an unnamed row says nothing, so it
 * stays off the list until its first prompt names it.
 */
export function blank(id: string) {
  return createEmptySessionState({ id, workingDir: "/tmp" });
}

export function spokenTo(id: string, text: string) {
  return recordTurn(blank(id), userTurn(text));
}

export type StoredSession = ReturnType<typeof blank>;

/**
 * What the store's `listSummaryPage` does in SQL: rows someone has
 * spoken to, newest first with the id as the tiebreak, from the cursor
 * on, at most `limit` of them. Keeping the stand-in honest about the
 * filter and the bound is the point — a stub that handed back the whole
 * list would hide exactly the paging the rail now depends on.
 */
export function summaryPageOf(
  stored: StoredSession[],
  { limit, after }: SessionSummaryPageOptions,
): SessionSummary[] {
  return [...stored]
    .filter((state) => state.turns.some((turn) => turn.kind === "user"))
    .map(summarizeSessionState)
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
    .filter(
      (row) =>
        !after ||
        row.updatedAt < after.updatedAt ||
        (row.updatedAt === after.updatedAt && row.id < after.id),
    )
    .slice(0, Math.max(0, limit));
}

export interface StubOptions {
  /**
   * By default the turn never settles, so the tests observe the rail at
   * the moment the prompt is sent. `settleTurns` is for the cases that
   * need the orchestrator idle afterwards — deleting a session is
   * refused while a turn holds it.
   */
  settleTurns?: boolean;
  listSummaryPage?: (options: SessionSummaryPageOptions) => SessionSummary[];
  countUnreadable?: () => number;
  /** Seed for `tui.sessionRail.order` — the operator's manual order. */
  order?: string[];
  /** Seed for `tui.sessionRail.pinned`. */
  pinned?: string[];
}

export function stubRuntime(
  stored: StoredSession[],
  { settleTurns = false, listSummaryPage, countUnreadable }: StubOptions = {},
): AgentRuntime {
  let created = 0;
  return {
    // The runtime's own contract: a deferred session (`persist: false`,
    // what the TUI mints) reaches the store only when something saves
    // it — its first turn — while a scheduled task's is written at once.
    createSession: (input?: { persist?: boolean }) => {
      created += 1;
      const fresh = blank(`s-new-${created}`);
      if (input?.persist !== false) stored.unshift(fresh);
      return fresh;
    },
    steer: () => false,
    runTurn: (session: unknown) =>
      settleTurns
        ? Promise.resolve({ session, reason: "reply", stepCount: 1 })
        : new Promise(() => {}),
    sessionStore: {
      listSummaryPage:
        listSummaryPage ??
        ((options: SessionSummaryPageOptions) =>
          summaryPageOf(stored, options)),
      countUnreadable: countUnreadable ?? (() => 0),
      listRecent: (limit: number) => stored.slice(0, limit),
      load: (id: string) => stored.find((s) => s.id === id) ?? null,
      // An upsert, like the real store's `save`: it INSERTs a session
      // that has no row yet (a deferred one the operator stamped a model
      // onto) and overwrites the row of one that has.
      save: (state: StoredSession) => {
        const at = stored.findIndex((s) => s.id === state.id);
        if (at >= 0) stored[at] = state;
        else stored.unshift(state);
      },
      delete: (id: string) => {
        const at = stored.findIndex((s) => s.id === id);
        if (at >= 0) stored.splice(at, 1);
      },
    },
    approvals: {
      clearSessionGrants: () => undefined,
      denyPendingForSession: () => 0,
      sessionGrants: () => [],
      // Switching into a thread re-raises the prompt its parked turn
      // asked off screen; nothing is ever parked in these tests.
      pendingRequestForSession: () => null,
    },
    // Deleting checks every origin's turns, not just the TUI's.
    turnController: { isBusy: () => false },
    // What `start()` reaches for besides the session store.
    getApprovalLevel: () => 5,
    taskStore: { list: () => [] },
    shutdown: async () => undefined,
    config: {
      update: { checkOnStartup: false, repo: "x/y" },
      tracing: { trace: { dir: "/tmp", enabled: false } },
    },
    profileStore: { list: () => [] },
    skillCatalog: [],
  } as unknown as AgentRuntime;
}

export function harness(stored: StoredSession[], options: StubOptions = {}) {
  const bus = makeTuiEventBus();
  const actions: TuiAction[] = [];
  bus.subscribe((a) => actions.push(a));
  // The rail's layout, held in memory instead of the developer's
  // config.json; `written` is every order snapshot the orchestrator
  // persisted and `pins` every pinned list.
  let order = [...(options.order ?? [])];
  let pinned = [...(options.pinned ?? [])];
  const written: string[][] = [];
  const pins: string[][] = [];
  const orchestrator = new ChatOrchestrator(stubRuntime(stored, options), bus, {
    maxSteps: 5,
    llamaUrl: "http://127.0.0.1:8080",
    readGateFacts: cloudGateFacts,
    sessionRailLayout: {
      read: () => ({ order, pinned }),
      write: (next) => {
        order = [...next.order];
        pinned = [...next.pinned];
        written.push([...next.order]);
        pins.push([...next.pinned]);
      },
    },
  });
  const lastOf = (
    type: "recent_sessions_updated" | "session_picker_opened",
  ) => {
    for (let i = actions.length - 1; i >= 0; i -= 1) {
      const action = actions[i];
      if (action?.type === type) return action.sessions;
    }
    return [] as readonly SessionPickerEntry[];
  };
  const rail = (): readonly SessionPickerEntry[] =>
    lastOf("recent_sessions_updated");
  const picker = (): readonly SessionPickerEntry[] =>
    lastOf("session_picker_opened");
  /** `morePages` on the last rail refresh: does the store hold more? */
  const morePages = (): boolean | null => {
    for (let i = actions.length - 1; i >= 0; i -= 1) {
      const action = actions[i];
      if (action?.type === "recent_sessions_updated") return action.morePages;
    }
    return null;
  };
  // `bus` is returned for the cases that have to arrive the way the app
  // sends them: a model pick reaches the orchestrator as an action, not
  // as a method call.
  return { orchestrator, bus, rail, picker, morePages, actions, written, pins };
}
