import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEmptySessionState,
  type ConversationTurn,
  type SessionState,
} from "../session/index.js";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("POST /api/sessions/{id}/rollback-last-turn (ATO-1298)", () => {
  let harness: Harness;
  beforeEach(async () => { harness = await startTestHarness(); });
  afterEach(async () => { vi.restoreAllMocks(); await harness.cleanup(); });

  const post = (id: string, body: unknown = {}) => fetch(`${harness.baseUrl}/api/sessions/${id}/rollback-last-turn`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  function seed(id: string, turns: ConversationTurn[], starts: number[]): SessionState {
    const state: SessionState = {
      ...createEmptySessionState({ id, workingDir: harness.workingDir }),
      status: "completed",
      turns,
      turnCount: starts.length,
      macroTurnStarts: starts,
    };
    harness.runtime.sessionStore.save(state);
    return state;
  }

  it("removes the last plain question and answer and returns the question", async () => {
    seed("rb-1", [
      { kind: "user", text: "first", at: 1 },
      { kind: "assistant_reply", text: "one", at: 2 },
      { kind: "user", text: "Hello", at: 3 },
      { kind: "assistant_reply", text: "Hi!", at: 4 },
    ], [2, 4]);
    const res = await post("rb-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "rb-1", text: "Hello" });
    const after = harness.runtime.sessionStore.load("rb-1");
    expect(after?.turns.map((t) => t.kind)).toEqual(["user", "assistant_reply"]);
    expect(after?.turnCount).toBe(1);
    expect(after?.macroTurnStarts).toEqual([2]);
  });

  it("refuses a turn with a tool and leaves the chat as it was", async () => {
    seed("rb-2", [
      { kind: "user", text: "read it", at: 1 },
      { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "a" }, at: 2 },
      { kind: "tool_result", tool: "os.fs.read", status: "ok", summary: "x", at: 3 },
      { kind: "assistant_reply", text: "done", at: 4 },
    ], [4]);
    const res = await post("rb-2");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("turn_has_tools");
    expect(harness.runtime.sessionStore.load("rb-2")?.turns).toHaveLength(4);
  });

  it("answers 409 turn_in_progress while the chat runs a turn", async () => {
    seed("rb-3", [
      { kind: "user", text: "a", at: 1 },
      { kind: "assistant_reply", text: "b", at: 2 },
    ], [2]);
    vi.spyOn(harness.runtime.turnController, "isBusy").mockImplementation((id: string) => id === "rb-3");
    const res = await post("rb-3");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("turn_in_progress");
    expect(harness.runtime.sessionStore.load("rb-3")?.turns).toHaveLength(2);
  });

  it("refuses with turn_mismatch when expectText is not the last question", async () => {
    seed("rb-5", [
      { kind: "user", text: "first", at: 1 },
      { kind: "assistant_reply", text: "one", at: 2 },
    ], [2]);
    const res = await post("rb-5", { expectText: "a question the agent never stored" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("turn_mismatch");
    expect(harness.runtime.sessionStore.load("rb-5")?.turns).toHaveLength(2);
    expect((await post("rb-5", { expectText: 42 })).status).toBe(400);
    expect((await post("rb-5", { expectText: "first" })).status).toBe(200);
  });

  it("refuses with turn_mismatch when the question's position differs", async () => {
    // q0 "continue" answered; the second "continue" failed and never reached the store.
    seed("rb-6", [
      { kind: "user", text: "continue", at: 1 },
      { kind: "assistant_reply", text: "a0", at: 2 },
    ], [2]);
    const res = await post("rb-6", { expectText: "continue", expectPriorQuestions: 1 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("turn_mismatch");
    expect(harness.runtime.sessionStore.load("rb-6")?.turns).toHaveLength(2);
    expect((await post("rb-6", { expectPriorQuestions: -1 })).status).toBe(400);
    expect((await post("rb-6", { expectText: "continue", expectPriorQuestions: 0 })).status).toBe(200);
  });

  it("keeps a real answer when the failed question on screen lines up with it after a clear (ATO-1420)", async () => {
    // "first" (cleared from the window), "continue" answered, a second
    // "continue" failed and never stored: the window counts 1 question before it.
    seed("rb-8", [
      { kind: "user", text: "first", at: 1 },
      { kind: "assistant_reply", text: "one", at: 2 },
      { kind: "user", text: "continue", at: 3 },
      { kind: "assistant_reply", text: "real answer", at: 4 },
    ], [2, 4]);
    const res = await post("rb-8", { expectText: "continue", expectPriorQuestions: 1, expectUnanswered: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("turn_mismatch");
    expect(harness.runtime.sessionStore.load("rb-8")?.turns).toHaveLength(4);
    expect((await post("rb-8", { expectUnanswered: "yes" })).status).toBe(400);
    expect(harness.runtime.sessionStore.load("rb-8")?.turns).toHaveLength(4);
  });

  it("refuses a stopped turn", async () => {
    seed("rb-7", [
      { kind: "user", text: "delete the build folder", at: 1 },
      { kind: "assistant_reply", text: "(stopped)", stopped: true, at: 2 },
    ], [2]);
    const res = await post("rb-7");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("turn_stopped");
  });

  it("answers 404 session_not_found for an unknown chat", async () => {
    const res = await post("nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("session_not_found");
  });

  it("stops a background compaction before writing", async () => {
    seed("rb-4", [
      { kind: "user", text: "a", at: 1 },
      { kind: "assistant_reply", text: "b", at: 2 },
    ], [2]);
    const cancel = vi.spyOn(harness.runtime, "cancelSessionCompaction");
    expect((await post("rb-4")).status).toBe(200);
    expect(cancel).toHaveBeenCalledWith("rb-4");
  });
});
