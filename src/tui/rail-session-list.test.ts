import { describe, expect, it } from "vitest";

import { recordTurn } from "../session/session-state.js";
import { userTurn } from "../session/conversation-turn.js";
import { blank, harness, spokenTo } from "./rail-session-harness.js";

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
      ...Array.from({ length: 30 }, (_, i) => spokenTo(`s-real-${i}`, `thread ${i}`)),
    ];
    const { orchestrator, rail } = harness(stored);
    orchestrator.refreshRecentSessions();
    const rows = rail();
    expect(rows).toHaveLength(30);
    expect(rows.every((entry) => entry.sessionId.startsWith("s-real-"))).toBe(true);
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
    const { orchestrator, rail } = harness(stored, { settleTurns: true });
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
