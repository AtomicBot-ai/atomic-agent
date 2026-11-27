import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

type CardJson = {
  task: { id: string; status: string };
  lane: string;
  laneSource: string;
  note: string | null;
  assignee: string | null;
};

/** ATO-2257: the task board over HTTP. */
describe("/api/task-board and /api/tasks/:id/board", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function createTask() {
    const session = harness.runtime.createSession();
    harness.runtime.sessionStore.save(session);
    return harness.runtime.taskStore.create({
      sessionId: session.id,
      userMessage: "write the release notes",
      origin: "http",
      maxAttempts: 3,
    });
  }

  function move(id: string, body: unknown) {
    return fetch(`${harness.baseUrl}/api/tasks/${id}/board`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("lists every task as a card in its status lane", async () => {
    const waiting = createTask();
    const running = createTask();
    harness.runtime.taskStore.markRunning(running.id, 1_000);

    const res = await fetch(`${harness.baseUrl}/api/task-board`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lanes: string[];
      cards: CardJson[];
      counts: Record<string, number>;
      available: boolean;
    };
    expect(body.lanes).toEqual(["todo", "doing", "review", "blocked", "done"]);
    expect(body.available).toBe(true);
    const byId = Object.fromEntries(body.cards.map((c) => [c.task.id, c.lane]));
    expect(byId).toEqual({ [waiting.id]: "todo", [running.id]: "doing" });
    expect(body.counts).toEqual({ todo: 1, doing: 1, review: 0, blocked: 0, done: 0 });
  });

  it("moves a card with a note and assignee and leaves the task's status alone", async () => {
    const task = createTask();
    const res = await move(task.id, { lane: "review", note: "check the wording", assignee: "writer" });
    expect(res.status).toBe(200);
    const card = (await res.json()) as CardJson;
    expect(card).toMatchObject({
      lane: "review",
      laneSource: "board",
      note: "check the wording",
      assignee: "writer",
      task: { id: task.id, status: "pending" },
    });
    expect(harness.runtime.taskStore.get(task.id)?.status).toBe("pending");

    const board = (await (await fetch(`${harness.baseUrl}/api/task-board`)).json()) as {
      cards: CardJson[];
    };
    expect(board.cards[0]).toMatchObject({ lane: "review", note: "check the wording" });
  });

  it("answers 400 for a bad lane or assignee and 404 for an unknown task", async () => {
    const task = createTask();
    const badLane = await move(task.id, { lane: "archive" });
    expect(badLane.status).toBe(400);
    expect(((await badLane.json()) as { error: { param: string } }).error.param).toBe("lane");
    const badAssignee = await move(task.id, { assignee: "Not A Profile" });
    expect(badAssignee.status).toBe(400);
    const missing = await move("missing", { lane: "done" });
    expect(missing.status).toBe(404);
    const badLimit = await fetch(`${harness.baseUrl}/api/task-board?limit=0`);
    expect(badLimit.status).toBe(400);
  });
});
