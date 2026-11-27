import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startTestHarness, type Harness } from "./test-harness.js";

type CardJson = {
  task: { id: string };
  lane: string;
  commentCount: number;
  dependsOn: string[];
  waitingOn: string[];
};

/** ATO-2498: comments, dependencies and assignable profiles over HTTP. */
describe("task board comments, dependencies and profiles", () => {
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

  const post = (path: string, body: unknown) =>
    fetch(`${harness.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const board = async () =>
    ((await (await fetch(`${harness.baseUrl}/api/task-board`)).json()) as { cards: CardJson[] }).cards;

  it("adds a person's comment and lists the thread newest first", async () => {
    const task = createTask();
    harness.runtime.taskStore.addBoardComment(task.id, { author: "agent", kind: "review", text: "ready" });
    const added = await post(`/api/tasks/${task.id}/board/comments`, { text: "  looks good  " });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ author: "person", kind: "comment", text: "looks good" });

    const res = await fetch(`${harness.baseUrl}/api/tasks/${task.id}/board/comments`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: { text: string; author: string }[]; available: boolean };
    expect(body.available).toBe(true);
    expect(body.comments.map((c) => c.text)).toEqual(["looks good", "ready"]);
    expect((await board())[0]?.commentCount).toBe(2);
  });

  it("refuses an empty comment, an unknown task and a bad limit", async () => {
    const task = createTask();
    const empty = await post(`/api/tasks/${task.id}/board/comments`, { text: "   " });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: { param: string } }).error.param).toBe("text");
    expect((await post(`/api/tasks/missing/board/comments`, { text: "x" })).status).toBe(404);
    expect((await fetch(`${harness.baseUrl}/api/tasks/missing/board/comments`)).status).toBe(404);
    expect((await fetch(`${harness.baseUrl}/api/tasks/${task.id}/board/comments?limit=0`)).status).toBe(400);
  });

  it("sets what a card waits on and shows it waiting until the other card is done", async () => {
    const first = createTask();
    const second = createTask();
    const set = await post(`/api/tasks/${second.id}/board`, { dependsOn: [first.id] });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ dependsOn: [first.id], waitingOn: [first.id] });

    await post(`/api/tasks/${first.id}/board`, { lane: "done" });
    const card = (await board()).find((c) => c.task.id === second.id);
    expect(card).toMatchObject({ dependsOn: [first.id], waitingOn: [] });

    const cleared = await post(`/api/tasks/${second.id}/board`, { dependsOn: null });
    expect(await cleared.json()).toMatchObject({ dependsOn: [] });
  });

  it("refuses a dependency on itself, on a missing task or in a cycle, and changes nothing", async () => {
    const a = createTask();
    const b = createTask();
    await post(`/api/tasks/${b.id}/board`, { dependsOn: [a.id] });
    for (const dependsOn of [[a.id + "x"], [a.id, a.id + "x"], "nope"]) {
      const res = await post(`/api/tasks/${a.id}/board`, { dependsOn });
      expect(res.status, JSON.stringify(dependsOn)).toBe(400);
    }
    const self = await post(`/api/tasks/${a.id}/board`, { dependsOn: [a.id] });
    expect(self.status).toBe(400);
    const cycle = await post(`/api/tasks/${a.id}/board`, { dependsOn: [b.id], lane: "review" });
    expect(cycle.status).toBe(400);
    expect(((await cycle.json()) as { error: { param: string } }).error.param).toBe("dependsOn");
    expect(harness.runtime.taskStore.boardDependencies(a.id)).toEqual([]);
    // The lane in the refused request was not applied either.
    expect((await board()).find((c) => c.task.id === a.id)?.lane).toBe("todo");
  });

  it("lists the profiles a card can be assigned to, the user's own among the built-ins", async () => {
    const dir = join(harness.stateDir, "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "writer.md"), "---\ndescription: writes release notes\n---\nWrite clearly.");
    const task = createTask();
    const res = await fetch(`${harness.baseUrl}/api/task-board/profiles?taskId=${task.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profiles: { name: string; description: string; source: string }[] };
    expect(body.profiles).toContainEqual({ name: "writer", description: "writes release notes", source: "user" });
    expect(body.profiles.map((p) => p.name)).toContain("review");
    expect((await fetch(`${harness.baseUrl}/api/task-board/profiles?taskId=missing`)).status).toBe(404);
  });
});
