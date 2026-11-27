import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEmptySessionState,
  type ConversationTurn,
  type SessionState,
} from "../session/index.js";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("versions of an edited message (ATO-2470)", () => {
  let harness: Harness;
  beforeEach(async () => { harness = await startTestHarness(); });
  afterEach(async () => { vi.restoreAllMocks(); await harness.cleanup(); });

  const post = (id: string, route: string, body: unknown) => fetch(`${harness.baseUrl}/api/sessions/${id}/${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const list = async (id: string) => {
    const res = await fetch(`${harness.baseUrl}/api/sessions/${id}/message-versions`);
    return { status: res.status, body: (await res.json()) as { questions?: Array<Record<string, unknown>>; error?: { code: string } } };
  };
  const texts = (id: string) => harness.runtime.sessionStore.load(id)!.turns
    .map((t) => (t.kind === "user" || t.kind === "assistant_reply" ? t.text : t.kind));

  function seed(id: string): SessionState {
    const turns: ConversationTurn[] = [
      { kind: "user", text: "A", at: 1 },
      { kind: "assistant_reply", text: "a", at: 2 },
      { kind: "user", text: "B", at: 3 },
      { kind: "assistant_reply", text: "b", at: 4 },
    ];
    const state: SessionState = {
      ...createEmptySessionState({ id, workingDir: harness.workingDir }),
      status: "completed",
      turns,
      turnCount: 2,
      macroTurnStarts: [2, 4],
    };
    harness.runtime.sessionStore.save(state);
    return state;
  }

  /** What the send of the edited text stores. */
  function answer(id: string, rows: ConversationTurn[]): void {
    const s = harness.runtime.sessionStore.load(id)!;
    const turns = [...s.turns, ...rows];
    harness.runtime.sessionStore.save({ ...s, status: "completed", turns, turnCount: s.turnCount + 1, macroTurnStarts: [...(s.macroTurnStarts ?? []), turns.length] });
  }

  it("an edit keeps the old message as a version, lists it, and switching puts it back (it survives the store)", async () => {
    seed("mv-1");
    const rewound = await post("mv-1", "rewind", { priorQuestions: 1, expectText: "B", files: false, keepBranch: true });
    expect(rewound.status).toBe(200);
    expect(texts("mv-1")).toEqual(["A", "a"]);
    answer("mv-1", [{ kind: "user", text: "B2", at: 5 }, { kind: "assistant_reply", text: "b2", at: 6 }]);

    const listed = await list("mv-1");
    expect(listed.status).toBe(200);
    expect(listed.body.questions).toEqual([{
      priorQuestions: 1,
      live: { text: "B2", at: 5, answerAt: 6 },
      versions: [{ ref: "b0", text: "B", at: 3, answerAt: 4, keptAt: expect.any(Number) }],
      compacted: false,
    }]);

    const switched = await post("mv-1", "switch-version", { priorQuestions: 1, expectText: "B2", ref: "b0" });
    expect(switched.status).toBe(200);
    expect(await switched.json()).toEqual({ id: "mv-1", text: "B", versions: 1 });
    expect(texts("mv-1")).toEqual(["A", "a", "B", "b"]);
    const stored = harness.runtime.sessionStore.load("mv-1")!;
    expect(stored.turnCount).toBe(2);
    expect(stored.macroTurnStarts).toEqual([2, 4]);
    expect(stored.messageBranches?.[0]?.turns.map((t) => (t.kind === "user" || t.kind === "assistant_reply" ? t.text : ""))).toEqual(["B2", "b2"]);
  });

  it("a rewind without keepBranch keeps nothing, as before", async () => {
    seed("mv-2");
    await post("mv-2", "rewind", { priorQuestions: 1, expectText: "B", files: false });
    expect(harness.runtime.sessionStore.load("mv-2")!.messageBranches).toBeUndefined();
    expect((await list("mv-2")).body.questions).toEqual([]);
  });

  it("refuses a stale question, a bad ref and an unknown chat, changing nothing", async () => {
    seed("mv-3");
    await post("mv-3", "rewind", { priorQuestions: 1, expectText: "B", files: false, keepBranch: true });
    answer("mv-3", [{ kind: "user", text: "B2", at: 5 }, { kind: "assistant_reply", text: "b2", at: 6 }]);
    const stale = await post("mv-3", "switch-version", { priorQuestions: 1, expectText: "B", ref: "b0" });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("point_mismatch");
    const bad = await post("mv-3", "switch-version", { priorQuestions: 1, ref: "x" });
    expect(bad.status).toBe(400);
    expect(texts("mv-3")).toEqual(["A", "a", "B2", "b2"]);
    expect((await list("nope")).status).toBe(404);
    const unknown = await post("nope", "switch-version", { priorQuestions: 0, ref: "b0" });
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("session_not_found");
  });
});
