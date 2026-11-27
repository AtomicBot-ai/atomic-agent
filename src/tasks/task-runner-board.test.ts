import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEmptySessionState } from "../session/index.js";
import type { SessionState } from "../session/index.js";

import { TaskRunner } from "./task-runner.js";
import type { TaskRunnerRuntime } from "./task-runner.js";
import { TaskStore } from "./task-store.js";
import { BOARD_FAILURE_FUSE_RUNS } from "./task-board-fuse.js";
import type { TaskRecord, TaskSchedule } from "./task-types.js";
import type { AssigneeResolver } from "./task-board-assignee.js";

/**
 * ATO-2497: the runner names the task a session is running (the board
 * tools act on its card), holds a card the agent blocked, and stops a
 * card that keeps failing.
 */
describe("TaskRunner and the task board", () => {
  let tmp: string;
  let store: TaskStore;
  let session: SessionState;
  let onTurn: (s: SessionState) => Promise<"reply" | "failed">;
  let runner: TaskRunner;
  let calls: { message: string; options: Parameters<TaskRunnerRuntime["runTurn"]>[2] }[];
  const makeRunner = (assignee?: AssigneeResolver): TaskRunner =>
    new TaskRunner({
      store,
      runtime: {
        runTurn: async (s, message, options) => {
          calls.push({ message, options });
          return { session: s, reason: await onTurn(s), stepCount: 1 };
        },
      },
      sessionLoader: { load: () => session },
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 10 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => undefined,
      ...(assignee ? { assignee } : {}),
    });

  beforeEach(() => {
    calls = [];
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-runner-board-"));
    store = new TaskStore({ dbFile: join(tmp, "tasks.sqlite") });
    session = createEmptySessionState({ id: "s-1", workingDir: "/tmp/work" });
    onTurn = async () => "reply";
    runner = makeRunner();
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const oneShot = (maxAttempts = 1): TaskRecord =>
    store.create({ sessionId: session.id, userMessage: "work", origin: "cli", maxAttempts });

  it("names the task running in a session only while its turn runs", async () => {
    const task = oneShot();
    let seen: TaskRecord | null = null;
    let otherSession: TaskRecord | null = null;
    onTurn = async () => {
      seen = runner.runningTaskInSession(session.id);
      otherSession = runner.runningTaskInSession("someone-else");
      return "reply";
    };
    await runner.runOne(task.id);
    expect(seen).toMatchObject({ id: task.id, status: "running" });
    expect(otherSession).toBeNull();
    expect(runner.runningTaskInSession(session.id)).toBeNull();
  });

  it("pauses a recurring task whose card the agent blocked during the run", async () => {
    const cron: TaskSchedule = { kind: "cron", expression: "0 9 * * *", tz: "UTC" };
    const now = Date.now();
    const task = store.create(
      {
        sessionId: session.id,
        userMessage: "daily digest",
        origin: "cli",
        maxAttempts: 3,
        schedule: cron,
        scheduledFor: now - 1,
      },
      now,
    );
    onTurn = async () => {
      store.updateBoardCard(task.id, { lane: "blocked" });
      return "reply";
    };
    const after = await runner.runOne(task.id);
    expect(after?.status).toBe("paused");
    expect(store.boardCards().find((c) => c.task.id === task.id)?.lane).toBe("blocked");
  });

  it("arms a recurring task as before when its card was not blocked", async () => {
    const cron: TaskSchedule = { kind: "cron", expression: "0 9 * * *", tz: "UTC" };
    const now = Date.now();
    const task = store.create(
      { sessionId: session.id, userMessage: "d", origin: "cli", maxAttempts: 3, schedule: cron, scheduledFor: now - 1 },
      now,
    );
    onTurn = async () => {
      store.updateBoardCard(task.id, { lane: "review" });
      return "reply";
    };
    const after = await runner.runOne(task.id);
    expect(after?.status).toBe("pending");
  });

  it(`stops retrying after ${BOARD_FAILURE_FUSE_RUNS} failed runs in a row and blocks the card`, async () => {
    const task = oneShot(10);
    onTurn = async () => "failed";
    let after: TaskRecord | null = null;
    for (let i = 0; i < BOARD_FAILURE_FUSE_RUNS; i += 1) after = await runner.runOne(task.id);
    expect(after?.status).toBe("paused");
    expect(store.boardCards().find((c) => c.task.id === task.id)?.lane).toBe("blocked");
    expect(store.listBoardComments(task.id)[0]?.kind).toBe("fuse");
    // The scheduler leaves it alone now.
    const drained = await runner.runDue(Date.now() + 60_000, 10);
    expect(drained.drained).toBe(0);
  });

  it("leaves a card waiting on another card for a later drain until that one is done (ATO-2498)", async () => {
    const first = oneShot();
    const second = oneShot();
    expect(store.setBoardDependencies(second.id, [first.id])).toEqual({ dependsOn: [first.id] });
    await runner.drainPending();
    expect(store.get(first.id)?.status).toBe("completed");
    // Left out of the drain that ran the card it waits on.
    expect(store.get(second.id)?.status).toBe("pending");
    // Completed, but someone moved its card back to Review: not done yet.
    store.updateBoardCard(first.id, { lane: "review" });
    await runner.drainPending();
    expect(store.get(second.id)?.status).toBe("pending");
    store.updateBoardCard(first.id, { lane: "done" });
    await runner.drainPending();
    expect(store.get(second.id)?.status).toBe("completed");
  });

  it("still runs a waiting card on an explicit Run now", async () => {
    const first = oneShot();
    const second = oneShot();
    store.setBoardDependencies(second.id, [first.id]);
    const after = await runner.runOne(second.id);
    expect(after?.status).toBe("completed");
  });

  it("runs a card as its assignee: instructions in the message, its tools and provider", async () => {
    const seen: string[] = [];
    runner = makeRunner((profile) => {
      seen.push(profile);
      return {
        profile,
        instructions: "Write in short sentences.",
        toolFilter: (name) => name === "os.fs.read",
        providerId: "cloud-writer",
        notes: [],
      };
    });
    const task = oneShot();
    store.updateBoardCard(task.id, { assignee: "writer" });
    await runner.runOne(task.id);
    expect(seen).toEqual(["writer"]);
    expect(calls[0]?.message).toContain('as the "writer" agent profile');
    expect(calls[0]?.message).toContain("Write in short sentences.");
    expect(calls[0]?.message).toContain("work");
    expect(calls[0]?.options?.providerId).toBe("cloud-writer");
    expect(calls[0]?.options?.toolFilter?.("os.fs.read")).toBe(true);
    expect(calls[0]?.options?.toolFilter?.("os.shell.exec")).toBe(false);
    expect(store.listBoardComments(task.id)).toEqual([]);
  });

  it("runs a card whose profile is gone as the main agent and says so on the card", async () => {
    runner = makeRunner(() => null);
    const task = oneShot();
    store.updateBoardCard(task.id, { assignee: "gone" });
    await runner.runOne(task.id);
    expect(calls[0]?.message).toBe("work");
    expect(calls[0]?.options?.toolFilter).toBeUndefined();
    expect(store.listBoardComments(task.id)[0]).toMatchObject({ author: "system", text: expect.stringContaining('"gone" was not found') });
  });

  it("keeps the request as is for a card with no assignee", async () => {
    let asked = 0;
    runner = makeRunner(() => {
      asked += 1;
      return null;
    });
    await runner.runOne(oneShot().id);
    expect(asked).toBe(0);
    expect(calls[0]?.message).toBe("work");
  });
});
