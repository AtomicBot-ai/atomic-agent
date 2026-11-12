import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

interface IdeaJson {
  id: string;
  kind: string;
  status: string;
  title: string;
  reason: string;
  evidence: { source: string; ref: string; excerpt: string };
  prompt: string;
  taskId: string | null;
}

describe("/api/ideas", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function failedTask(message: string): string {
    const store = harness.runtime.taskStore;
    const t = store.create({ userMessage: message, origin: "cli", maxAttempts: 1 });
    store.markRunning(t.id);
    store.markFailed(t.id, { category: "transport", message: "provider timed out" });
    return t.id;
  }

  async function post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${harness.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it("refresh offers a failed task with its evidence; list returns it", async () => {
    const taskId = failedTask("tidy the inbox");
    const res = await post("/api/ideas/refresh");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ideas: IdeaJson[]; added: string[] };
    expect(body.added).toHaveLength(1);
    expect(body.ideas[0]).toMatchObject({
      kind: "retry_task",
      status: "new",
      prompt: "tidy the inbox",
      evidence: { source: "task", ref: taskId, excerpt: "provider timed out" },
    });
    const listRes = await fetch(`${harness.baseUrl}/api/ideas?status=new`);
    const list = (await listRes.json()) as { ideas: IdeaJson[] };
    expect(list.ideas.map((i) => i.id)).toEqual([body.ideas[0]!.id]);
  });

  it("accept files a task with the edited prompt; a second accept is 409", async () => {
    failedTask("tidy the inbox");
    const refreshed = (await (await post("/api/ideas/refresh")).json()) as { ideas: IdeaJson[] };
    const id = refreshed.ideas[0]!.id;
    const res = await post(`/api/ideas/${id}/accept`, { prompt: "tidy the inbox, skip spam" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { idea: IdeaJson; task: { id: string } };
    expect(body.idea).toMatchObject({ status: "accepted", taskId: body.task.id });
    expect(harness.runtime.taskStore.get(body.task.id)?.userMessage).toBe("tidy the inbox, skip spam");
    expect(harness.runtime.taskStore.get(body.task.id)?.origin).toBe("http");

    const again = await post(`/api/ideas/${id}/accept`);
    expect(again.status).toBe(409);
    const err = (await again.json()) as { error: { code: string } };
    expect(err.error.code).toBe("idea_decided");
  });

  it("dismiss retires the idea for good", async () => {
    failedTask("tidy the inbox");
    const refreshed = (await (await post("/api/ideas/refresh")).json()) as { ideas: IdeaJson[] };
    const id = refreshed.ideas[0]!.id;
    const res = await post(`/api/ideas/${id}/dismiss`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { idea: IdeaJson }).idea.status).toBe("dismissed");
    const after = (await (await post("/api/ideas/refresh")).json()) as { ideas: IdeaJson[]; added: string[] };
    expect(after.added).toEqual([]);
    expect(after.ideas).toEqual([]);
  });

  it("answers 404 for an unknown idea and 400 for a bad status or prompt", async () => {
    expect((await post("/api/ideas/nope/accept")).status).toBe(404);
    expect((await post("/api/ideas/nope/dismiss")).status).toBe(404);
    expect((await fetch(`${harness.baseUrl}/api/ideas?status=done`)).status).toBe(400);
    failedTask("tidy the inbox");
    const refreshed = (await (await post("/api/ideas/refresh")).json()) as { ideas: IdeaJson[] };
    const bad = await post(`/api/ideas/${refreshed.ideas[0]!.id}/accept`, { prompt: 42 });
    expect(bad.status).toBe(400);
  });
});
