import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../agent/agent-loop.js";
import {
  DetachedTurns,
  droppedPreview,
  formatReplayGapNotice,
  TurnEventBuffer,
} from "./detached-turns.js";
import { DEFAULT_RING_BUFFER_SIZE } from "./tui-state.js";

describe("DetachedTurns", () => {
  it("take removes and returns the parked controller", () => {
    const turns = new DetachedTurns();
    const controller = new AbortController();
    turns.park("s1", controller);
    expect(turns.has("s1")).toBe(true);
    expect(turns.take("s1")).toBe(controller);
    expect(turns.has("s1")).toBe(false);
    expect(turns.take("s1")).toBeNull();
  });

  it("release is identity-checked so a finished turn cannot release its successor", () => {
    const turns = new DetachedTurns();
    const first = new AbortController();
    const second = new AbortController();
    turns.park("s1", first);
    // The same session gets re-parked with a NEWER turn's controller
    // (switch back, run again, switch away again) before the first
    // turn's finally block runs.
    turns.park("s1", second);
    expect(turns.release("s1", first)).toBe(false);
    expect(turns.has("s1")).toBe(true);
    expect(turns.release("s1", second)).toBe(true);
    expect(turns.has("s1")).toBe(false);
  });

  it("abortAll aborts every parked turn and empties the registry", () => {
    const turns = new DetachedTurns();
    const a = new AbortController();
    const b = new AbortController();
    turns.park("s1", a);
    turns.park("s2", b);
    turns.abortAll();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(turns.size).toBe(0);
  });
});

describe("TurnEventBuffer", () => {
  const event = (text: string): AgentLoopEvent => ({
    type: "user_message",
    text,
  });

  it("records only sessions with a begun turn and snapshots in order", () => {
    const buffer = new TurnEventBuffer();
    buffer.record("s-unstarted", event("dropped on the floor"));
    expect(buffer.snapshot("s-unstarted")).toBeNull();
    buffer.begin("s1");
    buffer.record("s1", event("one"));
    buffer.record("s1", event("two"));
    expect(buffer.snapshot("s1")).toEqual({
      events: [event("one"), event("two")],
      dropped: 0,
    });
    buffer.end("s1");
    expect(buffer.snapshot("s1")).toBeNull();
  });

  it("caps at the transcript ring size, dropping and counting the oldest", () => {
    const buffer = new TurnEventBuffer();
    buffer.begin("s1");
    for (let i = 0; i < DEFAULT_RING_BUFFER_SIZE + 3; i += 1) {
      buffer.record("s1", event(`e${i}`));
    }
    const snap = buffer.snapshot("s1");
    expect(snap?.events).toHaveLength(DEFAULT_RING_BUFFER_SIZE);
    expect(snap?.dropped).toBe(3);
    // Oldest gone, newest kept.
    expect(snap?.events[0]).toEqual(event("e3"));
    expect(snap?.events.at(-1)).toEqual(
      event(`e${DEFAULT_RING_BUFFER_SIZE + 2}`),
    );
    // The gap the operator is told about names the loss.
    expect(formatReplayGapNotice(3)).toContain("3 events");
  });

  it("begin restarts a session's log from empty", () => {
    const buffer = new TurnEventBuffer();
    buffer.begin("s1");
    buffer.record("s1", event("stale"));
    buffer.begin("s1");
    expect(buffer.snapshot("s1")).toEqual({ events: [], dropped: 0 });
  });
});

describe("droppedPreview", () => {
  it.each([
    ["short text", "short text"],
    ["multi\n  line\ttext", "multi line text"],
    ["x".repeat(80), `${"x".repeat(59)}…`],
  ])("flattens and elides %j", (input, expected) => {
    expect(droppedPreview(input)).toBe(expected);
  });
});
