import { describe, expect, it } from "vitest";

import { createEmptySessionState, recordTurn } from "../session/session-state.js";
import { userTurn } from "../session/conversation-turn.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import { makeTuiEventBus } from "./make-event-bus.js";
import type { TuiAction } from "./tui-action.js";
import type { SessionPickerEntry } from "./tui-state.js";

/**
 * The rail lists threads that have been spoken to. `+ new` mints a
 * session immediately — the store row has to exist for scheduled tasks
 * and webhooks that hold only an id — but an unnamed row says nothing,
 * so it stays off the list until its first prompt names it.
 */
function blank(id: string) {
  return createEmptySessionState({ id, workingDir: "/tmp" });
}

function spokenTo(id: string, text: string) {
  return recordTurn(blank(id), userTurn(text));
}

function stubRuntime(
  stored: ReturnType<typeof blank>[],
  settleTurns = false,
): AgentRuntime {
  let created = 0;
  return {
    createSession: () => {
      created += 1;
      const fresh = blank(`s-new-${created}`);
      stored.unshift(fresh);
      return fresh;
    },
    steer: () => false,
    // By default the turn never settles, so the tests observe the rail
    // at the moment the prompt is sent. `settleTurns` is for the cases
    // that need the orchestrator idle afterwards — deleting a session is
    // refused while a turn holds it.
    runTurn: (session: unknown) =>
      settleTurns
        ? Promise.resolve({ session, reason: "reply", stepCount: 1 })
        : new Promise(() => {}),
    sessionStore: {
      listRecent: () => stored,
      load: (id: string) => stored.find((s) => s.id === id) ?? null,
      delete: (id: string) => {
        const at = stored.findIndex((s) => s.id === id);
        if (at >= 0) stored.splice(at, 1);
      },
    },
    approvals: { clearSessionGrants: () => undefined },
    config: {
      update: { checkOnStartup: false, repo: "x/y" },
      tracing: { trace: { dir: "/tmp", enabled: false } },
    },
    profileStore: { list: () => [] },
    skillCatalog: [],
  } as unknown as AgentRuntime;
}

function harness(stored: ReturnType<typeof blank>[], settleTurns = false) {
  const bus = makeTuiEventBus();
  const actions: TuiAction[] = [];
  bus.subscribe((a) => actions.push(a));
  const orchestrator = new ChatOrchestrator(stubRuntime(stored, settleTurns), bus, {
    maxSteps: 5,
    llamaUrl: "http://127.0.0.1:8080",
  });
  const rail = (): readonly SessionPickerEntry[] => {
    for (let i = actions.length - 1; i >= 0; i -= 1) {
      const action = actions[i];
      if (action?.type === "recent_sessions_updated") return action.sessions;
    }
    return [];
  };
  const picker = (): readonly SessionPickerEntry[] => {
    for (let i = actions.length - 1; i >= 0; i -= 1) {
      const action = actions[i];
      if (action?.type === "session_picker_opened") return action.sessions;
    }
    return [];
  };
  return { orchestrator, rail, picker, actions };
}

describe("rail session list", () => {
  it("hides sessions nobody has spoken to", () => {
    const stored = [spokenTo("s-old", "an older thread"), blank("s-blank")];
    const { orchestrator, rail } = harness(stored);
    orchestrator.refreshRecentSessions();
    expect(rail().map((entry) => entry.sessionId)).toEqual(["s-old"]);
  });

  it("adds no row for a brand-new session", () => {
    const stored = [spokenTo("s-old", "an older thread")];
    const { orchestrator, rail } = harness(stored);
    orchestrator.newSession();
    expect(rail().map((entry) => entry.sessionId)).toEqual(["s-old"]);
  });

  it("shows the row the moment the first prompt is sent, named by it", () => {
    // The store cannot answer yet: the user turn only reaches SQLite
    // when the whole turn finishes. The row is carried by the prompt.
    const stored = [spokenTo("s-old", "an older thread")];
    const { orchestrator, rail } = harness(stored);
    orchestrator.newSession();
    orchestrator.sendMessage("build me a website");
    const rows = rail();
    expect(rows.map((entry) => entry.sessionId)).toEqual(["s-new-1", "s-old"]);
    expect(rows[0]?.preview).toBe("build me a website");
  });

  it("does not double the row once the store catches up", () => {
    // The stand-in and the stored row are the same session; the rail
    // keys rows by id, so a duplicate would render twice.
    const stored = [spokenTo("s-old", "older")];
    const { orchestrator, rail } = harness(stored);
    orchestrator.newSession();
    orchestrator.sendMessage("first prompt");
    // The turn settles and the store now has the user turn.
    const created = stored.find((s) => s.id === "s-new-1");
    if (created) {
      stored[stored.indexOf(created)] = recordTurn(created, userTurn("first prompt"));
    }
    orchestrator.refreshRecentSessions();
    const ids = rail().map((entry) => entry.sessionId);
    expect(ids).toEqual(["s-new-1", "s-old"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("opens the picker on the same list the rail shows", () => {
    // The menu's "N recent" badge counts the rail's entries, so a picker
    // with its own idea of the set would contradict the number that
    // advertised it.
    const stored = [spokenTo("s-old", "older"), blank("s-blank")];
    const { orchestrator, picker } = harness(stored);
    orchestrator.openSessionPicker();
    expect(picker().map((entry) => entry.sessionId)).toEqual(["s-old"]);
  });

  it("drops the stand-in when that session is deleted", async () => {
    // Deletion is refused while a turn holds the session, so let the
    // turn settle first — the stored row still has no user turn (the
    // stub does not write one back), so only the stand-in is keeping
    // the row on screen.
    const stored = [spokenTo("s-old", "older")];
    const { orchestrator, rail } = harness(stored, true);
    orchestrator.newSession();
    orchestrator.sendMessage("about to be deleted");
    expect(rail().map((e) => e.sessionId)).toContain("s-new-1");
    await new Promise((r) => setTimeout(r, 5));
    orchestrator.deleteSession("s-new-1");
    expect(rail().map((e) => e.sessionId)).not.toContain("s-new-1");
  });
});

describe("rail session list — steering", () => {
  it("names the session when /steer opens the conversation", () => {
    // `steerMessage` can start the FIRST turn; a hook on sendMessage
    // alone would leave the rail empty for that path.
    const stored = [spokenTo("s-old", "older")];
    const { orchestrator, rail } = harness(stored);
    orchestrator.newSession();
    orchestrator.steerMessage("opening line");
    expect(rail()[0]?.preview).toBe("opening line");
  });
});
