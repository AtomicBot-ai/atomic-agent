import { describe, expect, it } from "vitest";

import { recordTurn } from "../session/session-state.js";
import { userTurn } from "../session/conversation-turn.js";
import {
  blank,
  cloudGateFacts,
  harness,
  spokenTo,
  stubRuntime,
} from "./rail-session-harness.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import { makeTuiEventBus } from "./make-event-bus.js";
import type { LocalTurnGateFacts } from "./local-turn-gate.js";
import type { TuiAction } from "./tui-action.js";
import type { SessionPickerEntry } from "./tui-state.js";

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
      stored[stored.indexOf(created)] = recordTurn(
        created,
        userTurn("first prompt"),
      );
    }
    orchestrator.refreshRecentSessions();
    const ids = rail().map((entry) => entry.sessionId);
    expect(ids).toEqual(["s-new-1", "s-old"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lists every spoken-to session, newest first, with no cap", () => {
    // The rail used to stop at 25 rows and scan 200: the 26th thread
    // was unreachable, and past 200 stored sessions even the scan ran
    // out. The rail and the picker window their own rows, so the list
    // itself carries everything.
    const stored = Array.from({ length: 300 }, (_, i) => ({
      ...spokenTo(`s-${i}`, `thread ${i}`),
      updatedAt: 1_000_000 + i,
    }));
    const { orchestrator, rail } = harness(stored);
    orchestrator.refreshRecentSessions();
    const rows = rail();
    expect(rows).toHaveLength(300);
    expect(rows[0]?.sessionId).toBe("s-299");
    expect(rows[299]?.sessionId).toBe("s-0");
    const updatedAts = rows.map((entry) => entry.updatedAt);
    expect(updatedAts).toEqual([...updatedAts].sort((a, b) => b - a));
  });

  it("does not let unnamed sessions push real threads out of the list", () => {
    // Every `+ new` persists an unnamed session, and scheduled tasks
    // mint one each. With no window to squat there is nothing for them
    // to push out — every real thread is listed, every blank one hidden.
    const stored = [
      ...Array.from({ length: 60 }, (_, i) => blank(`s-blank-${i}`)),
      ...Array.from({ length: 30 }, (_, i) =>
        spokenTo(`s-real-${i}`, `thread ${i}`),
      ),
    ];
    const { orchestrator, rail } = harness(stored);
    orchestrator.refreshRecentSessions();
    const rows = rail();
    expect(rows).toHaveLength(30);
    expect(rows.every((entry) => entry.sessionId.startsWith("s-real-"))).toBe(
      true,
    );
  });

  it("shows '(empty)' for a session whose first prompt is an empty string", () => {
    const stored = [spokenTo("s-empty", "")];
    const { orchestrator, rail } = harness(stored);
    orchestrator.refreshRecentSessions();
    expect(rail().map((entry) => entry.preview)).toEqual(["(empty)"]);
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
    const { orchestrator, rail } = harness(stored, {
      settleTurns: { settleTurns: true },
    });
    orchestrator.newSession();
    orchestrator.sendMessage("about to be deleted");
    expect(rail().map((e) => e.sessionId)).toContain("s-new-1");
    await new Promise((r) => setTimeout(r, 5));
    orchestrator.deleteSession("s-new-1");
    expect(rail().map((e) => e.sessionId)).not.toContain("s-new-1");
  });
});

describe("rail session list — detached turns", () => {
  it("keeps the detached thread's stand-in when the next thread's first prompt lands", () => {
    // A single pending-row slot used to be enough because switching was
    // refused mid-turn. With detach, the old thread's first turn is
    // still unsaved when the new thread's first prompt arrives — and
    // evicting its stand-in would make the one session the operator
    // most needs to find again invisible until its turn finishes.
    const stored: ReturnType<typeof blank>[] = [];
    const { orchestrator, rail } = harness(stored);
    orchestrator.newSession();
    orchestrator.sendMessage("first thread work");
    orchestrator.newSession();
    orchestrator.sendMessage("second thread work");
    const rows = rail();
    expect(rows.map((e) => e.preview)).toEqual([
      "second thread work",
      "first thread work",
    ]);
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

describe("rail session list — manual order", () => {
  it("follows tui.sessionRail.order once the operator has arranged the rail", () => {
    const stored = [
      spokenTo("s-3", "third"),
      spokenTo("s-2", "second"),
      spokenTo("s-1", "first"),
    ];
    const { orchestrator, rail } = harness(stored, {
      order: ["s-1", "s-3", "s-2"],
    });
    orchestrator.refreshRecentSessions();
    expect(rail().map((e) => e.sessionId)).toEqual(["s-1", "s-3", "s-2"]);
  });

  it("gives an imported thread the slot its own date earns", () => {
    // The operator arranged the rail this year; an import has just
    // written a transcript from four years ago. It belongs beside the
    // old rows, not above the ones the operator arranged.
    const now = Date.now();
    const stored = [
      { ...spokenTo("s-2", "second"), updatedAt: now - 1_000 },
      { ...spokenTo("s-1", "first"), updatedAt: now - 2_000 },
      {
        ...spokenTo("s-imported", "a transcript from four years ago"),
        updatedAt: now - 4 * 365 * 24 * 3_600_000,
      },
    ];
    const { orchestrator, rail } = harness(stored, { order: ["s-2", "s-1"] });
    orchestrator.refreshRecentSessions();
    expect(rail().map((e) => e.sessionId)).toEqual([
      "s-2",
      "s-1",
      "s-imported",
    ]);
  });

  it("puts threads the order has never seen on top", () => {
    const stored = [
      spokenTo("s-new", "started after the arranging"),
      spokenTo("s-2", "second"),
      spokenTo("s-1", "first"),
    ];
    const { orchestrator, rail } = harness(stored, { order: ["s-1", "s-2"] });
    orchestrator.refreshRecentSessions();
    expect(rail().map((e) => e.sessionId)).toEqual(["s-new", "s-1", "s-2"]);
  });

  it("keeps the first-prompt stand-in on top of an arranged list", () => {
    const stored = [spokenTo("s-2", "second"), spokenTo("s-1", "first")];
    const { orchestrator, rail } = harness(stored, { order: ["s-1", "s-2"] });
    orchestrator.newSession();
    orchestrator.sendMessage("brand new thread");
    expect(rail().map((e) => e.sessionId)).toEqual(["s-new-1", "s-1", "s-2"]);
  });

  it("moveSession snapshots the displayed list with the row on its new slot, then re-emits", () => {
    const stored = [
      spokenTo("s-3", "third"),
      spokenTo("s-2", "second"),
      spokenTo("s-1", "first"),
    ];
    const { orchestrator, rail, written } = harness(stored);
    orchestrator.refreshRecentSessions();
    // Recency until touched: nothing has been written yet.
    expect(written).toEqual([]);
    orchestrator.moveSession("s-1", 0);
    expect(written).toEqual([["s-1", "s-3", "s-2"]]);
    expect(rail().map((e) => e.sessionId)).toEqual(["s-1", "s-3", "s-2"]);
    orchestrator.moveSession("s-3", 2);
    expect(written.at(-1)).toEqual(["s-1", "s-2", "s-3"]);
    expect(rail().map((e) => e.sessionId)).toEqual(["s-1", "s-2", "s-3"]);
  });

  it("writes nothing for a move that changes nothing or names no row", () => {
    const stored = [spokenTo("s-2", "second"), spokenTo("s-1", "first")];
    const { orchestrator, written, actions } = harness(stored);
    orchestrator.refreshRecentSessions();
    const emitted = actions.length;
    orchestrator.moveSession("s-2", 0);
    orchestrator.moveSession("s-2", -4);
    orchestrator.moveSession("s-ghost", 1);
    expect(written).toEqual([]);
    expect(actions.length).toBe(emitted);
  });
});

describe("rail session list — pinned block", () => {
  it("keeps pinned threads on top whatever their recency, in the manual order", () => {
    const stored = [
      spokenTo("s-4", "newest"),
      spokenTo("s-3", "third"),
      spokenTo("s-2", "second"),
      spokenTo("s-1", "oldest"),
    ];
    const { orchestrator, rail } = harness(stored, {
      order: ["s-1", "s-3"],
      pinned: ["s-3", "s-1"],
    });
    orchestrator.refreshRecentSessions();
    const rows = rail();
    expect(rows.map((e) => e.sessionId)).toEqual(["s-1", "s-3", "s-4", "s-2"]);
    expect(rows.map((e) => e.pinned)).toEqual([true, true, false, false]);
  });

  it("keeps a pinned thread on top of a long list, built from its first prompt", () => {
    // #367 took the 25-row window off the rail, so every thread is
    // listed; the pin still decides which one leads.
    const stored = Array.from({ length: 30 }, (_, i) =>
      spokenTo(`s-real-${i}`, `thread ${i}`),
    );
    const { orchestrator, rail } = harness(stored, {
      order: [],
      pinned: ["s-real-29"],
    });
    orchestrator.refreshRecentSessions();
    const rows = rail();
    expect(rows).toHaveLength(30);
    expect(rows[0]).toMatchObject({
      sessionId: "s-real-29",
      preview: "thread 29",
      pinned: true,
    });
  });

  it("shows nothing for a pinned id that no longer exists, and prunes it on the next write", () => {
    const stored = [spokenTo("s-2", "second"), spokenTo("s-1", "first")];
    const { orchestrator, rail, pins } = harness(stored, {
      order: [],
      pinned: ["s-gone"],
    });
    orchestrator.refreshRecentSessions();
    expect(rail().map((e) => e.sessionId)).toEqual(["s-2", "s-1"]);
    orchestrator.togglePinned("s-1");
    expect(pins.at(-1)).toEqual(["s-1"]);
  });

  it("togglePinned appends to the block, then releases to the top of the rest", () => {
    const stored = [
      spokenTo("s-3", "third"),
      spokenTo("s-2", "second"),
      spokenTo("s-1", "first"),
    ];
    const { orchestrator, rail, written, pins } = harness(stored, {
      order: [],
      pinned: ["s-2"],
    });
    orchestrator.refreshRecentSessions();
    expect(rail().map((e) => e.sessionId)).toEqual(["s-2", "s-3", "s-1"]);
    orchestrator.togglePinned("s-1");
    expect(pins.at(-1)).toEqual(["s-2", "s-1"]);
    expect(written.at(-1)).toEqual(["s-2", "s-1", "s-3"]);
    expect(rail().map((e) => [e.sessionId, e.pinned])).toEqual([
      ["s-2", true],
      ["s-1", true],
      ["s-3", false],
    ]);
    orchestrator.togglePinned("s-2");
    expect(pins.at(-1)).toEqual(["s-1"]);
    expect(rail().map((e) => e.sessionId)).toEqual(["s-1", "s-2", "s-3"]);
    expect(rail()[1]?.pinned).toBe(false);
  });

  it("a drop inside the block pins, a drop below it unpins", () => {
    const stored = [
      spokenTo("s-3", "third"),
      spokenTo("s-2", "second"),
      spokenTo("s-1", "first"),
    ];
    const { orchestrator, rail, pins } = harness(stored, {
      order: [],
      pinned: ["s-1"],
    });
    orchestrator.refreshRecentSessions();
    expect(rail().map((e) => e.sessionId)).toEqual(["s-1", "s-3", "s-2"]);
    // Drag s-2 onto the pinned row: it joins the block.
    orchestrator.moveSession("s-2", 0);
    expect(pins.at(-1)).toEqual(["s-2", "s-1"]);
    expect(rail().map((e) => e.pinned)).toEqual([true, true, false]);
    // Drag s-1 below the block: it leaves it.
    orchestrator.moveSession("s-1", 2);
    expect(pins.at(-1)).toEqual(["s-2"]);
    expect(rail().map((e) => e.sessionId)).toEqual(["s-2", "s-3", "s-1"]);
  });

  it("pinning writes the config only — the session store is not touched", () => {
    const stored = [spokenTo("s-2", "second"), spokenTo("s-1", "first")];
    const before = stored.map((s) => ({ ...s }));
    const { orchestrator, rail } = harness(stored);
    orchestrator.refreshRecentSessions();
    const updatedAt = rail().map((e) => e.updatedAt);
    orchestrator.togglePinned("s-1");
    expect(stored).toEqual(before);
    expect(rail().map((e) => e.updatedAt)).toEqual([
      updatedAt[1],
      updatedAt[0],
    ]);
  });
});
