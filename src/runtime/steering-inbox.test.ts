import { describe, expect, it } from "vitest";
import { MAX_PENDING_STEERS, SteeringInbox } from "./steering-inbox.js";

/** An inbox with one session already accepting steers, as a live turn leaves it. */
function openInbox(...sessionIds: string[]): SteeringInbox {
  const inbox = new SteeringInbox();
  for (const id of sessionIds) inbox.open(id);
  return inbox;
}

describe("SteeringInbox", () => {
  it("drains what was pushed, in order", () => {
    const inbox = openInbox("s1");
    expect(inbox.push("s1", "first")).toBe(true);
    expect(inbox.push("s1", "second")).toBe(true);
    expect(inbox.drain("s1")).toEqual(["first", "second"]);
  });

  it("empties the slot on drain so one message is delivered once", () => {
    const inbox = openInbox("s1");
    inbox.push("s1", "only");
    expect(inbox.drain("s1")).toEqual(["only"]);
    expect(inbox.drain("s1")).toEqual([]);
  });

  it("returns an empty array for a session that was never pushed to", () => {
    expect(new SteeringInbox().drain("nobody")).toEqual([]);
  });

  it("keeps sessions isolated", () => {
    const inbox = openInbox("a", "b");
    inbox.push("a", "for-a");
    inbox.push("b", "for-b");
    expect(inbox.drain("a")).toEqual(["for-a"]);
    expect(inbox.drain("b")).toEqual(["for-b"]);
  });

  it("trims and rejects blank text", () => {
    const inbox = openInbox("s1");
    expect(inbox.push("s1", "   ")).toBe(false);
    expect(inbox.push("s1", "\n\t")).toBe(false);
    expect(inbox.push("s1", "  padded  ")).toBe(true);
    expect(inbox.drain("s1")).toEqual(["padded"]);
  });

  it("refuses past the per-session cap instead of dropping the oldest", () => {
    const inbox = openInbox("s1");
    for (let i = 0; i < MAX_PENDING_STEERS; i += 1) {
      expect(inbox.push("s1", `m${i}`)).toBe(true);
    }
    // A refusal is the signal the caller needs to park the message
    // somewhere else; silently evicting m0 would lose it.
    expect(inbox.push("s1", "overflow")).toBe(false);
    const drained = inbox.drain("s1");
    expect(drained).toHaveLength(MAX_PENDING_STEERS);
    expect(drained[0]).toBe("m0");
    expect(drained).not.toContain("overflow");
  });

  it("accepts again once the cap is drained", () => {
    const inbox = openInbox("s1");
    for (let i = 0; i < MAX_PENDING_STEERS; i += 1) inbox.push("s1", `m${i}`);
    expect(inbox.push("s1", "nope")).toBe(false);
    inbox.drain("s1");
    expect(inbox.push("s1", "yes")).toBe(true);
  });

  it("peek does not consume", () => {
    const inbox = openInbox("s1");
    inbox.push("s1", "held");
    expect(inbox.peek("s1")).toEqual(["held"]);
    expect(inbox.peek("s1")).toEqual(["held"]);
    expect(inbox.drain("s1")).toEqual(["held"]);
  });

  it("clear drops one session, clearAll drops every session", () => {
    const inbox = openInbox("a", "b");
    inbox.push("a", "x");
    inbox.push("b", "y");
    inbox.clear("a");
    expect(inbox.peek("a")).toEqual([]);
    expect(inbox.peek("b")).toEqual(["y"]);
    inbox.clearAll();
    expect(inbox.peek("b")).toEqual([]);
  });

  describe("acceptance window", () => {
    it("refuses a push for a session no turn has opened", () => {
      const inbox = new SteeringInbox();
      expect(inbox.isOpen("s1")).toBe(false);
      expect(inbox.push("s1", "nobody is listening")).toBe(false);
      expect(inbox.peek("s1")).toEqual([]);
    });

    it("closeAndDrain hands back what is pending and refuses the next push", () => {
      const inbox = openInbox("s1");
      expect(inbox.push("s1", "just in time")).toBe(true);
      expect(inbox.closeAndDrain("s1")).toEqual(["just in time"]);
      // This is the lost-update window: the turn's final drain has
      // happened, so accepting here would strand the message until an
      // unrelated later turn picked it up.
      expect(inbox.push("s1", "one microtask too late")).toBe(false);
      expect(inbox.peek("s1")).toEqual([]);
      expect(inbox.isOpen("s1")).toBe(false);
    });

    it("closeAndDrain is idempotent", () => {
      const inbox = openInbox("s1");
      inbox.push("s1", "x");
      expect(inbox.closeAndDrain("s1")).toEqual(["x"]);
      expect(inbox.closeAndDrain("s1")).toEqual([]);
    });

    it("a mid-turn drain keeps the window open", () => {
      const inbox = openInbox("s1");
      inbox.push("s1", "step 0");
      expect(inbox.drain("s1")).toEqual(["step 0"]);
      expect(inbox.isOpen("s1")).toBe(true);
      expect(inbox.push("s1", "step 1")).toBe(true);
    });

    it("closes only the session it was asked about", () => {
      const inbox = openInbox("a", "b");
      inbox.closeAndDrain("a");
      expect(inbox.push("a", "no")).toBe(false);
      expect(inbox.push("b", "yes")).toBe(true);
    });

    it("clear and clearAll close the window too", () => {
      const inbox = openInbox("a", "b");
      inbox.clear("a");
      expect(inbox.push("a", "no")).toBe(false);
      inbox.clearAll();
      expect(inbox.push("b", "no")).toBe(false);
    });

    it("reopens for the next turn on the same session", () => {
      const inbox = openInbox("s1");
      inbox.closeAndDrain("s1");
      inbox.open("s1");
      expect(inbox.push("s1", "next turn")).toBe(true);
    });
  });
});
