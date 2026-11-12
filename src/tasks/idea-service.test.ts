import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acceptIdea, refreshIdeas } from "./idea-service.js";
import { IdeaStore } from "./idea-store.js";
import { IdeaStateError } from "./idea-types.js";
import { TaskStore } from "./task-store.js";
import { TaskValidationError } from "./task-types.js";

describe("idea service", () => {
  let tmp: string;
  let tasks: TaskStore;
  let ideas: IdeaStore;
  const noSessions = { listRecent: () => [] };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "idea-service-"));
    const file = join(tmp, "tasks.sqlite");
    tasks = new TaskStore({ dbFile: file });
    ideas = new IdeaStore({ dbFile: file });
  });

  afterEach(() => {
    ideas.close();
    tasks.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function failedTask(message: string, now: number) {
    const t = tasks.create({ userMessage: message, origin: "cli", maxAttempts: 1 }, now);
    tasks.markRunning(t.id, now + 1);
    return tasks.markFailed(t.id, { category: "transport", message: "provider timed out" }, now + 2);
  }

  function createTask(input: { sessionId: string | null; userMessage: string }) {
    return tasks.create({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      userMessage: input.userMessage,
      origin: "cli",
      maxAttempts: 1,
    });
  }

  it("refresh turns a failed task into one idea with evidence, and does not repeat it", () => {
    const now = Date.now();
    const t = failedTask("tidy the inbox", now - 10_000);
    const first = refreshIdeas({ ideas, tasks, sessions: noSessions, now });
    expect(first.added).toHaveLength(1);
    expect(first.added[0]).toMatchObject({
      kind: "retry_task",
      sourceKey: `task:${t.id}`,
      evidence: { source: "task", ref: t.id, excerpt: "provider timed out" },
      prompt: "tidy the inbox",
    });
    expect(refreshIdeas({ ideas, tasks, sessions: noSessions, now }).added).toEqual([]);
  });

  it("refresh reads goals from the sessions it is given", () => {
    const now = Date.now();
    const sessions = {
      listRecent: () => [
        {
          id: "s-goal",
          metadata: {
            goal: {
              version: 1, status: "paused", criteria: [{ text: "ship it", mark: "pending" }],
              checks: [], maxRounds: 10, roundsUsed: 1, judgeFailures: 0,
              createdAt: now - 5_000, updatedAt: now - 1_000,
            },
          },
        },
      ],
    };
    const res = refreshIdeas({ ideas, tasks, sessions, now });
    expect(res.added.map((i) => [i.kind, i.sessionId])).toEqual([["resume_goal", "s-goal"]]);
  });

  it("accept files one task with the edited prompt and links it to the idea", () => {
    const now = Date.now();
    failedTask("tidy the inbox", now - 10_000);
    const [idea] = refreshIdeas({ ideas, tasks, sessions: noSessions, now }).added;
    const accepted = acceptIdea(ideas, createTask, idea!.id, { prompt: "  tidy the inbox, skip spam  " });
    expect(accepted?.task.userMessage).toBe("tidy the inbox, skip spam");
    expect(accepted?.idea).toMatchObject({ status: "accepted", taskId: accepted?.task.id });
    expect(() => acceptIdea(ideas, createTask, idea!.id)).toThrow(IdeaStateError);
    expect(tasks.list({ status: "pending" })).toHaveLength(1);
    // The idea is decided, so its source is never offered again.
    expect(refreshIdeas({ ideas, tasks, sessions: noSessions, now }).added).toEqual([]);
  });

  it("a refused task leaves the idea new with its old prompt", () => {
    const now = Date.now();
    failedTask("tidy the inbox", now - 10_000);
    const [idea] = refreshIdeas({ ideas, tasks, sessions: noSessions, now }).added;
    expect(() =>
      acceptIdea(ideas, () => { throw new Error("queue closed"); }, idea!.id, { prompt: "other" }),
    ).toThrow("queue closed");
    expect(ideas.get(idea!.id)).toMatchObject({ status: "new", prompt: "tidy the inbox", taskId: null });
  });

  it("rejects an empty edited prompt before deciding anything", () => {
    const now = Date.now();
    failedTask("tidy the inbox", now - 10_000);
    const [idea] = refreshIdeas({ ideas, tasks, sessions: noSessions, now }).added;
    expect(() => acceptIdea(ideas, createTask, idea!.id, { prompt: "   " })).toThrow(TaskValidationError);
    expect(ideas.get(idea!.id)?.status).toBe("new");
  });

  it("returns null for an unknown idea", () => {
    expect(acceptIdea(ideas, createTask, "missing")).toBeNull();
  });
});
