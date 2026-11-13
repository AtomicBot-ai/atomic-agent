import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createGoalState,
  readGoalState,
  setGoalStatus,
  withGoalState,
  type GoalState,
} from "../agent/goal/index.js";

import { decideGoalAction, parseGoalAction } from "./route-session-goal.js";
import { startTestHarness, type Harness } from "./test-harness.js";

const NOW = 1_000;

function goal(overrides: Partial<GoalState> = {}): GoalState {
  return { ...createGoalState({ criteria: ["tests pass", "docs updated"], checks: ["npm test"] }, 1), ...overrides };
}

describe("decideGoalAction (the TUI's /goal rules)", () => {
  const idle = { turnRunning: false, controlGoal: () => false, now: NOW };

  it("sets a new goal, keeps the stored checks, and hands back the kickoff message", () => {
    const out = decideGoalAction({ action: "set", criteria: ["ship it"], maxRounds: 4 }, { ...idle, stored: goal() });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.goal?.criteria.map((c) => c.text)).toEqual(["ship it"]);
    expect(out.goal?.checks).toEqual(["npm test"]);
    expect(out.goal?.maxRounds).toBe(4);
    expect(out.goal?.status).toBe("active");
    expect(out.store).toEqual(out.goal);
    expect(out.message).toContain("1. ship it");
  });

  it("refuses to set or resume while a turn runs", () => {
    const busy = { ...idle, turnRunning: true };
    const set = decideGoalAction({ action: "set", criteria: ["x"] }, { ...busy, stored: null });
    const resume = decideGoalAction({ action: "resume" }, { ...busy, stored: goal({ status: "paused" }) });
    expect(set).toMatchObject({ ok: false, code: "turn_in_progress" });
    expect(resume).toMatchObject({ ok: false, code: "turn_in_progress" });
  });

  it("asks a running goal to pause after its round, else stores it paused", () => {
    const asked: string[] = [];
    const running = decideGoalAction({ action: "pause" }, {
      ...idle, stored: goal(), controlGoal: (verb) => { asked.push(verb); return true; },
    });
    expect(running).toMatchObject({ ok: true, pending: true });
    expect(running.ok && running.store).toBeUndefined();
    expect(asked).toEqual(["pause"]);

    const stored = decideGoalAction({ action: "pause" }, { ...idle, stored: goal() });
    expect(stored.ok && stored.store?.status).toBe("paused");
    expect(stored.ok && stored.store?.statusReason).toBe("paused by you");
  });

  it("refuses to pause a goal that is not running, or none", () => {
    expect(decideGoalAction({ action: "pause" }, { ...idle, stored: null })).toMatchObject({ ok: false, code: "no_goal" });
    expect(decideGoalAction({ action: "pause" }, { ...idle, stored: goal({ status: "blocked" }) }))
      .toMatchObject({ ok: false, code: "goal_not_running" });
  });

  it("resumes with the continuation once rounds ran, and refuses a complete goal", () => {
    const paused = setGoalStatus(goal({ roundsUsed: 2 }), "paused", 5, "paused by you");
    const out = decideGoalAction({ action: "resume" }, { ...idle, stored: paused });
    expect(out.ok && out.store?.status).toBe("active");
    expect(out.ok && out.message).toMatch(/^Goal round 3 of 10/);
    const fresh = decideGoalAction({ action: "resume" }, { ...idle, stored: goal({ status: "paused" }) });
    expect(fresh.ok && fresh.message).toMatch(/^Work on this goal/);
    expect(decideGoalAction({ action: "resume" }, { ...idle, stored: goal({ status: "complete" }) }))
      .toMatchObject({ ok: false, code: "goal_complete" });
  });

  it("clears a running goal after its round, any other at once", () => {
    const running = decideGoalAction({ action: "clear" }, { ...idle, stored: goal(), controlGoal: () => true });
    expect(running).toMatchObject({ ok: true, pending: true, goal: null });
    expect(running.ok && running.store).toBeUndefined();
    const paused = decideGoalAction({ action: "clear" }, { ...idle, stored: goal({ status: "paused" }), controlGoal: () => true });
    expect(paused).toMatchObject({ ok: true, store: null, goal: null });
  });
});

describe("parseGoalAction", () => {
  it("reads the four actions and rejects the rest", () => {
    expect(parseGoalAction({ action: "pause" })).toEqual({ ok: true, action: { action: "pause" } });
    expect(parseGoalAction({ action: "set", criteria: [" a ", "", "b"], maxRounds: 3 }))
      .toEqual({ ok: true, action: { action: "set", criteria: ["a", "b"], maxRounds: 3 } });
    expect(parseGoalAction({ action: "go" }).ok).toBe(false);
    expect(parseGoalAction({ action: "set", criteria: ["  "] }).ok).toBe(false);
    expect(parseGoalAction({ action: "set", criteria: "a; b" }).ok).toBe(false);
    expect(parseGoalAction({ action: "set", criteria: ["a"], maxRounds: 0 }).ok).toBe(false);
    expect(parseGoalAction({ action: "set", criteria: ["a"], maxRounds: 2.5 }).ok).toBe(false);
    expect(parseGoalAction(null).ok).toBe(false);
  });
});

describe("/api/sessions/{id}/goal", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const post = (id: string, body: unknown): Promise<Response> =>
    fetch(`${harness.baseUrl}/api/sessions/${id}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const storeGoal = (id: string, state: GoalState | null): void => {
    const s = harness.runtime.sessionStore.load(id)!;
    harness.runtime.sessionStore.save({ ...s, metadata: withGoalState(s.metadata, state) });
  };

  it("reads the stored goal, null without one, 404 for an unknown chat", async () => {
    const session = harness.runtime.createSession();
    let res = await fetch(`${harness.baseUrl}/api/sessions/${session.id}/goal`);
    expect(await res.json()).toEqual({ sessionId: session.id, goal: null, running: false });
    storeGoal(session.id, goal());
    res = await fetch(`${harness.baseUrl}/api/sessions/${session.id}/goal`);
    const body = (await res.json()) as { goal: GoalState };
    expect(body.goal.criteria.map((c) => c.mark)).toEqual(["pending", "pending"]);
    expect((await fetch(`${harness.baseUrl}/api/sessions/nope/goal`)).status).toBe(404);
  });

  it("lists the goal on session rows and on the full session", async () => {
    const session = harness.runtime.createSession();
    storeGoal(session.id, goal({ roundsUsed: 1 }));
    const list = (await (await fetch(`${harness.baseUrl}/api/sessions`)).json()) as {
      sessions: Array<{ id: string; goal: GoalState | null }>;
    };
    expect(list.sessions.find((s) => s.id === session.id)?.goal?.roundsUsed).toBe(1);
    const full = (await (await fetch(`${harness.baseUrl}/api/sessions/${session.id}`)).json()) as { goal: GoalState | null };
    expect(full.goal?.roundsUsed).toBe(1);
  });

  it("sets a goal on a chat that does not exist yet, then pauses, resumes and clears it", async () => {
    const id = "goal-http-new-chat";
    let res = await post(id, { action: "set", criteria: ["a file named done.txt exists"], maxRounds: 3 });
    expect(res.status).toBe(200);
    const set = (await res.json()) as { goal: GoalState; message: string };
    expect(set.goal.maxRounds).toBe(3);
    expect(set.message).toContain("done.txt");
    expect(readGoalState(harness.runtime.sessionStore.load(id)?.metadata)?.status).toBe("active");

    res = await post(id, { action: "pause" });
    expect(((await res.json()) as { goal: GoalState }).goal.status).toBe("paused");
    res = await post(id, { action: "resume" });
    expect(((await res.json()) as { goal: GoalState; message: string }).goal.status).toBe("active");
    res = await post(id, { action: "clear" });
    expect(await res.json()).toEqual({ sessionId: id, goal: null });
    expect(readGoalState(harness.runtime.sessionStore.load(id)?.metadata)).toBeNull();
  });

  it("answers 409 with the code the TUI would have said in words", async () => {
    const session = harness.runtime.createSession();
    const res = await post(session.id, { action: "pause" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("no_goal");
    expect((await post("nope", { action: "clear" })).status).toBe(404);
    expect((await post(session.id, { action: "set", criteria: [] })).status).toBe(400);
  });

  it("hands pause to the running goal, and refuses a new goal between its rounds", async () => {
    const session = harness.runtime.createSession();
    storeGoal(session.id, goal());
    // An open stream on the chat: a goal run holds it across rounds.
    harness.completionRegistry.register({
      completionId: "chatcmpl-goal", sessionId: session.id, controller: new AbortController(), startedAt: 0,
    });
    const asked: string[] = [];
    harness.runtime.controlGoal = (id, verb) => { asked.push(`${id}:${verb}`); return true; };
    const paused = await post(session.id, { action: "pause" });
    expect(await paused.json()).toMatchObject({ pending: true, goal: { status: "active" } });
    expect(asked).toEqual([`${session.id}:pause`]);
    expect(readGoalState(harness.runtime.sessionStore.load(session.id)?.metadata)?.status).toBe("active");
    const set = await post(session.id, { action: "set", criteria: ["other"] });
    expect(set.status).toBe(409);
    expect(((await set.json()) as { error: { code: string } }).error.code).toBe("turn_in_progress");
    harness.completionRegistry.unregister("chatcmpl-goal");
  });
});
