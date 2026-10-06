import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../agent/agent-loop.js";
import { createEmptySessionState } from "../session/session-state.js";
import {
  DetachedTurns,
  droppedPreview,
  formatReplayGapNotice,
  TurnEventBuffer,
} from "./detached-turns.js";
import { DEFAULT_RING_BUFFER_SIZE } from "./tui-state.js";

const live = (id: string) => createEmptySessionState({ id, workingDir: "/tmp" });

describe("DetachedTurns", () => {
  it("take removes and returns the parked controller", () => {
    const turns = new DetachedTurns();
    const controller = new AbortController();
    turns.park(live("s1"), controller);
    expect(turns.has("s1")).toBe(true);
    expect(turns.take("s1")).toBe(controller);
    expect(turns.has("s1")).toBe(false);
    expect(turns.take("s1")).toBeNull();
  });

  it("keeps the live session for a switch-back the store cannot answer", () => {
    // A deferred session backgrounded mid-first-turn has no store row
    // until the turn saves; the parked copy is the only one there is.
    const turns = new DetachedTurns();
    const session = live("s1");
    turns.park(session, new AbortController());
    expect(turns.sessionFor("s1")).toBe(session);
    expect(turns.sessionFor("s2")).toBeNull();
    turns.take("s1");
    expect(turns.sessionFor("s1")).toBeNull();
  });

  it("release is identity-checked so a finished turn cannot release its successor", () => {
    const turns = new DetachedTurns();
    const first = new AbortController();
    const second = new AbortController();
    turns.park(live("s1"), first);
    // The same session gets re-parked with a NEWER turn's controller
    // (switch back, run again, switch away again) before the first
    // turn's finally block runs.
    turns.park(live("s1"), second);
    expect(turns.release("s1", first)).toBe(false);
    expect(turns.has("s1")).toBe(true);
    expect(turns.release("s1", second)).toBe(true);
    expect(turns.has("s1")).toBe(false);
  });

  it("abortAll aborts every parked turn and empties the registry", () => {
    const turns = new DetachedTurns();
    const a = new AbortController();
    const b = new AbortController();
    turns.park(live("s1"), a);
    turns.park(live("s2"), b);
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
  const step = (stepIndex: number): AgentLoopEvent => ({
    type: "step_started",
    stepIndex,
  });
  const reply = (text: string): AgentLoopEvent => ({
    type: "llm_event",
    event: { type: "assistant_delta", text },
  });
  const thought = (stepIndex: number, text: string): AgentLoopEvent => ({
    type: "llm_event",
    event: { type: "reasoning_delta", stepIndex, text },
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
      buffer.record("s1", step(i));
    }
    const snap = buffer.snapshot("s1");
    expect(snap?.events).toHaveLength(DEFAULT_RING_BUFFER_SIZE);
    expect(snap?.dropped).toBe(3);
    // Oldest gone, newest kept.
    expect(snap?.events[0]).toEqual(step(3));
    expect(snap?.events.at(-1)).toEqual(step(DEFAULT_RING_BUFFER_SIZE + 2));
    // The gap the operator is told about names the loss.
    expect(formatReplayGapNotice(3)).toContain("3 events");
  });

  it("stores a streamed reply as one event, so it cannot crowd the turn out", () => {
    // ATO-37: one event per token filled the ring with a single answer,
    // and a switch-back mid-reply came back to a gap notice over half a
    // sentence, the operator's own prompt gone.
    const buffer = new TurnEventBuffer();
    buffer.begin("s1");
    buffer.record("s1", event("explain the build"));
    buffer.record("s1", step(0));
    for (let i = 0; i < DEFAULT_RING_BUFFER_SIZE * 4; i += 1) {
      buffer.record("s1", reply("w "));
    }
    const snap = buffer.snapshot("s1");
    expect(snap?.dropped).toBe(0);
    expect(snap?.events).toEqual([
      event("explain the build"),
      step(0),
      reply("w ".repeat(DEFAULT_RING_BUFFER_SIZE * 4)),
    ]);
  });

  it("joins reasoning only within one step, and only adjacent pieces", () => {
    const buffer = new TurnEventBuffer();
    buffer.begin("s1");
    buffer.record("s1", thought(0, "a"));
    buffer.record("s1", thought(0, "b"));
    buffer.record("s1", thought(1, "c"));
    buffer.record("s1", reply("x"));
    buffer.record("s1", thought(1, "d"));
    buffer.record("s1", reply("y"));
    buffer.record("s1", reply("z"));
    expect(buffer.snapshot("s1")?.events).toEqual([
      thought(0, "ab"),
      thought(1, "c"),
      reply("x"),
      thought(1, "d"),
      reply("yz"),
    ]);
  });

  it("joins without rewriting the events the reducer was handed", () => {
    const buffer = new TurnEventBuffer();
    buffer.begin("s1");
    const first = reply("a");
    buffer.record("s1", first);
    buffer.record("s1", reply("b"));
    expect(first).toEqual(reply("a"));
  });

  it("keeps the turn's prompt when an overflow takes the head", () => {
    const buffer = new TurnEventBuffer();
    buffer.begin("s1");
    buffer.record("s1", event("the prompt"));
    for (let i = 0; i < DEFAULT_RING_BUFFER_SIZE + 2; i += 1) {
      buffer.record("s1", step(i));
    }
    const snap = buffer.snapshot("s1");
    expect(snap?.events).toHaveLength(DEFAULT_RING_BUFFER_SIZE);
    expect(snap?.dropped).toBe(3);
    expect(snap?.events[0]).toEqual(event("the prompt"));
    // What went is the oldest of the rest.
    expect(snap?.events[1]).toEqual(step(3));
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
