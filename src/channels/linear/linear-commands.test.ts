import { describe, expect, it, vi } from "vitest";

import { parseLinearCommand, runLinearCommand } from "./linear-commands.js";
import { LINEAR_QUEUE_LIMIT, LinearTurnQueue } from "./linear-turn-queue.js";

describe("parseLinearCommand", () => {
  it.each([
    ["/status", "status"],
    ["/new", "new"],
    ["/cancel", "cancel"],
    ["/stop", "cancel"],
    ["/help", "help"],
    ["Stop!", "cancel"],
    ["status.", "status"],
  ])("reads %j as %s", (text, command) => {
    expect(parseLinearCommand(text)).toBe(command);
  });

  it.each(["stop the deploy", "status of ENG-7?", "new feature please", ""])("leaves %j as a request", (text) => {
    expect(parseLinearCommand(text)).toBeNull();
  });
});

function sessions(current: string | null) {
  const state = { current };
  return {
    state,
    map: {
      get: () => ({ current: state.current }),
      rotate: vi.fn(() => {
        state.current = null;
      }),
    } as never,
  };
}

describe("runLinearCommand", () => {
  it("/new refuses while a turn runs and archives otherwise", () => {
    const turns = new LinearTurnQueue();
    const s = sessions("s1");
    const release = vi.fn();
    turns.add("i1");
    const busy = runLinearCommand("new", { issueId: "i1", sessions: s.map, turns, pendingApprovals: 0, releaseApprovalSession: release });
    expect(busy).toContain("/cancel");
    expect(s.state.current).toBe("s1");
    turns.cancel("i1");
    const done = runLinearCommand("new", { issueId: "i1", sessions: s.map, turns, pendingApprovals: 0, releaseApprovalSession: release });
    expect(done).toContain("`s1` archived");
    expect(s.state.current).toBeNull();
    expect(release).toHaveBeenCalledWith("s1");
  });

  it("/cancel aborts the running and queued requests of that issue only", () => {
    const turns = new LinearTurnQueue();
    const a = turns.add("i1");
    const b = turns.add("i1");
    const other = turns.add("i2");
    const reply = runLinearCommand("cancel", { issueId: "i1", sessions: sessions(null).map, turns, pendingApprovals: 0 });
    expect(reply).toBe("Cancelling the current request and 1 queued.");
    expect(a.signal.aborted && b.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
  });

  it("/status says what is running and waiting", () => {
    const turns = new LinearTurnQueue();
    turns.add("i1");
    turns.add("i1");
    const reply = runLinearCommand("status", { issueId: "i1", sessions: sessions("s9").map, turns, pendingApprovals: 1 });
    expect(reply).toBe("This issue is on session `s9`. Working on a request, 1 more waiting. 1 approval waiting for an answer.");
  });
});

describe("LinearTurnQueue", () => {
  it("has room up to the limit and frees it as turns finish", () => {
    const turns = new LinearTurnQueue();
    const held = Array.from({ length: LINEAR_QUEUE_LIMIT }, () => turns.add("i1"));
    expect(turns.hasRoom("i1")).toBe(false);
    turns.remove("i1", held[0]!);
    expect(turns.hasRoom("i1")).toBe(true);
    for (const c of held.slice(1)) turns.remove("i1", c);
    expect(turns.busy("i1")).toBe(false);
  });
});
