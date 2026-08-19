import { describe, expect, it } from "vitest";
import { MAX_PENDING_STEERS, SteeringInbox } from "./steering-inbox.js";

describe("SteeringInbox", () => {
  it("drains what was pushed, in order", () => {
    const inbox = new SteeringInbox();
    expect(inbox.push("s1", "first")).toBe(true);
    expect(inbox.push("s1", "second")).toBe(true);
    expect(inbox.drain("s1")).toEqual(["first", "second"]);
  });

  it("empties the slot on drain so one message is delivered once", () => {
    const inbox = new SteeringInbox();
    inbox.push("s1", "only");
    expect(inbox.drain("s1")).toEqual(["only"]);
    expect(inbox.drain("s1")).toEqual([]);
  });

  it("returns an empty array for a session that was never pushed to", () => {
    expect(new SteeringInbox().drain("nobody")).toEqual([]);
  });

  it("keeps sessions isolated", () => {
    const inbox = new SteeringInbox();
    inbox.push("a", "for-a");
    inbox.push("b", "for-b");
    expect(inbox.drain("a")).toEqual(["for-a"]);
    expect(inbox.drain("b")).toEqual(["for-b"]);
  });

  it("trims and rejects blank text", () => {
    const inbox = new SteeringInbox();
    expect(inbox.push("s1", "   ")).toBe(false);
    expect(inbox.push("s1", "\n\t")).toBe(false);
    expect(inbox.push("s1", "  padded  ")).toBe(true);
    expect(inbox.drain("s1")).toEqual(["padded"]);
  });

  it("refuses past the per-session cap instead of dropping the oldest", () => {
    const inbox = new SteeringInbox();
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
    const inbox = new SteeringInbox();
    for (let i = 0; i < MAX_PENDING_STEERS; i += 1) inbox.push("s1", `m${i}`);
    expect(inbox.push("s1", "nope")).toBe(false);
    inbox.drain("s1");
    expect(inbox.push("s1", "yes")).toBe(true);
  });

  it("peek does not consume", () => {
    const inbox = new SteeringInbox();
    inbox.push("s1", "held");
    expect(inbox.peek("s1")).toEqual(["held"]);
    expect(inbox.peek("s1")).toEqual(["held"]);
    expect(inbox.drain("s1")).toEqual(["held"]);
  });

  it("clear drops one session, clearAll drops every session", () => {
    const inbox = new SteeringInbox();
    inbox.push("a", "x");
    inbox.push("b", "y");
    inbox.clear("a");
    expect(inbox.peek("a")).toEqual([]);
    expect(inbox.peek("b")).toEqual(["y"]);
    inbox.clearAll();
    expect(inbox.peek("b")).toEqual([]);
  });
});
