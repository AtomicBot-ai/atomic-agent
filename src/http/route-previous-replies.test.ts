import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEmptySessionState,
  type ConversationTurn,
  type SessionState,
} from "../session/index.js";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("earlier answers kept by a regenerate (ATO-864)", () => {
  let harness: Harness;
  beforeEach(async () => { harness = await startTestHarness(); });
  afterEach(async () => { vi.restoreAllMocks(); await harness.cleanup(); });

  const post = (id: string, route: string, body: unknown = {}) => fetch(`${harness.baseUrl}/api/sessions/${id}/${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const list = async (id: string) => {
    const res = await fetch(`${harness.baseUrl}/api/sessions/${id}/previous-replies`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

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

  /** What a resend of the question stores after a rollback. */
  function answerAgain(id: string, rows: ConversationTurn[], status: SessionState["status"] = "completed") {
    const s = harness.runtime.sessionStore.load(id)!;
    const turns = [...s.turns, ...rows];
    harness.runtime.sessionStore.save({
      ...s,
      status,
      turns,
      turnCount: s.turnCount + 1,
      macroTurnStarts: [...(s.macroTurnStarts ?? []), turns.length],
    });
  }

  it("keeps the old answer across a regenerate, lists it, and puts it back (it survives the store)", async () => {
    seed("pr-1", [
      { kind: "user", text: "Hello", at: 1 },
      { kind: "assistant_reply", text: "old", at: 2 },
    ], [2]);
    const rolled = await post("pr-1", "rollback-last-turn");
    expect(await rolled.json()).toEqual({ id: "pr-1", text: "Hello", previousReplies: 1 });
    // Kept beside the transcript, never in it.
    expect(harness.runtime.sessionStore.load("pr-1")?.turns).toEqual([]);

    answerAgain("pr-1", [
      { kind: "user", text: "Hello", at: 3 },
      { kind: "assistant_reply", text: "new", at: 4 },
    ]);
    const listed = await list("pr-1");
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ id: "pr-1", question: "Hello", questionStored: true });
    expect((listed.body.previous as Array<{ index: number; text: string }>).map((p) => [p.index, p.text])).toEqual([[0, "old"]]);

    const restored = await post("pr-1", "restore-previous-reply");
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ id: "pr-1", text: "old", previousReplies: 1 });
    const after = harness.runtime.sessionStore.load("pr-1");
    expect(after?.turns.map((t) => (t.kind === "user" || t.kind === "assistant_reply" ? t.text : t.kind))).toEqual(["Hello", "old"]);
    expect(after?.turnCount).toBe(1);
    expect(after?.macroTurnStarts).toEqual([2]);
    expect(after?.previousReplies?.replies.map((r) => r.reply.text)).toEqual(["new"]);
  });

  it("goes back to the old answer when the new try failed", async () => {
    seed("pr-2", [
      { kind: "user", text: "Hello", at: 1 },
      { kind: "assistant_reply", text: "old", at: 2 },
    ], [2]);
    expect((await post("pr-2", "rollback-last-turn")).status).toBe(200);
    answerAgain("pr-2", [
      { kind: "user", text: "Hello", at: 3 },
      { kind: "assistant_reply", text: "(this turn failed before it could answer — net: down. Nothing from it took effect.)", at: 4 },
    ], "failed");
    const restored = await post("pr-2", "restore-previous-reply", { index: 0 });
    expect(await restored.json()).toEqual({ id: "pr-2", text: "old", previousReplies: 0 });
    const after = harness.runtime.sessionStore.load("pr-2");
    expect(after?.status).toBe("pending");
    expect(after?.turns).toHaveLength(2);
    expect(after?.previousReplies).toBeUndefined();
  });

  it("refuses to swap out a new answer that used tools and leaves the chat as it was", async () => {
    seed("pr-3", [
      { kind: "user", text: "Hello", at: 1 },
      { kind: "assistant_reply", text: "old", at: 2 },
    ], [2]);
    expect((await post("pr-3", "rollback-last-turn")).status).toBe(200);
    answerAgain("pr-3", [
      { kind: "user", text: "Hello", at: 3 },
      { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "a" }, at: 4 },
      { kind: "tool_result", tool: "os.fs.read", status: "ok", summary: "x", at: 5 },
      { kind: "assistant_reply", text: "new", at: 6 },
    ]);
    const res = await post("pr-3", "restore-previous-reply");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("turn_has_tools");
    expect(harness.runtime.sessionStore.load("pr-3")?.turns).toHaveLength(4);
  });

  it("answers no_previous_reply, bad_index, turn_in_progress and 404 as documented", async () => {
    seed("pr-4", [
      { kind: "user", text: "Hello", at: 1 },
      { kind: "assistant_reply", text: "only", at: 2 },
    ], [2]);
    const none = await post("pr-4", "restore-previous-reply");
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe("no_previous_reply");
    expect((await list("pr-4")).body).toMatchObject({ question: null, previous: [] });

    expect((await post("pr-4", "rollback-last-turn")).status).toBe(200);
    expect((await post("pr-4", "restore-previous-reply", { index: "x" })).status).toBe(400);
    const far = await post("pr-4", "restore-previous-reply", { index: 5 });
    expect(far.status).toBe(400);
    expect(((await far.json()) as { error: { code: string } }).error.code).toBe("bad_index");

    vi.spyOn(harness.runtime.turnController, "isBusy").mockImplementation((id: string) => id === "pr-4");
    const busy = await post("pr-4", "restore-previous-reply");
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe("turn_in_progress");
    vi.restoreAllMocks();

    // The new try never reached the store: the question comes back with the answer.
    const cancel = vi.spyOn(harness.runtime, "cancelSessionCompaction");
    const back = await post("pr-4", "restore-previous-reply");
    expect(back.status).toBe(200);
    expect(cancel).toHaveBeenCalledWith("pr-4");
    expect(harness.runtime.sessionStore.load("pr-4")?.turns.map((t) => t.kind)).toEqual(["user", "assistant_reply"]);

    expect((await list("nope")).status).toBe(404);
    expect((await post("nope", "restore-previous-reply")).status).toBe(404);
  });
});
