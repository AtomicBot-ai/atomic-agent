import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdeaStore } from "./idea-store.js";
import { IDEAS_PER_KIND_MAX, IdeaStateError, type IdeaCandidate } from "./idea-types.js";
import { TaskStore } from "./task-store.js";

function candidate(sourceKey: string, overrides: Partial<IdeaCandidate> = {}): IdeaCandidate {
  return {
    kind: "retry_task",
    sourceKey,
    title: `Retry: ${sourceKey}`,
    reason: "This task failed and has not been run again.",
    evidence: { source: "task", ref: sourceKey, excerpt: "boom", at: 1 },
    prompt: `do ${sourceKey}`,
    sessionId: null,
    ...overrides,
  };
}

describe("IdeaStore", () => {
  let tmp: string;
  let store: IdeaStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "idea-store-"));
    store = new IdeaStore({ dbFile: join(tmp, "tasks.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("adds new candidates once and keeps their evidence", () => {
    const first = store.sync([candidate("task:a"), candidate("task:b")], 10);
    expect(first.added.map((i) => i.sourceKey).sort()).toEqual(["task:a", "task:b"]);
    const again = store.sync([candidate("task:a"), candidate("task:b")], 20);
    expect(again.added).toEqual([]);
    expect(again.retired).toEqual([]);
    const [a] = store.list({ status: "new" }).filter((i) => i.sourceKey === "task:a");
    expect(a).toMatchObject({
      status: "new",
      taskId: null,
      evidence: { source: "task", ref: "task:a", excerpt: "boom", at: 1 },
      createdAt: 10,
    });
  });

  it("never offers a dismissed or accepted source again", () => {
    store.sync([candidate("task:a"), candidate("task:b")], 10);
    const [a, b] = ["task:a", "task:b"].map(
      (k) => store.list().find((i) => i.sourceKey === k)!,
    );
    store.dismiss(a!.id, 11);
    store.claimForAccept(b!.id, null, 12);
    store.attachTask(b!.id, "t-1", 12);
    const res = store.sync([candidate("task:a"), candidate("task:b")], 13);
    expect(res.added).toEqual([]);
    expect(store.list({ status: "new" })).toEqual([]);
    expect(store.get(a!.id)?.status).toBe("dismissed");
    expect(store.get(b!.id)).toMatchObject({ status: "accepted", taskId: "t-1", decidedAt: 12 });
  });

  it("retires undecided ideas whose source is no longer offered, and only those", () => {
    store.sync([candidate("task:a"), candidate("task:b"), candidate("task:c")], 10);
    const c = store.list().find((i) => i.sourceKey === "task:c")!;
    store.dismiss(c.id, 11);
    const res = store.sync([candidate("task:b")], 12);
    expect(res.retired).toHaveLength(1);
    expect(store.list().map((i) => i.sourceKey).sort()).toEqual(["task:b", "task:c"]);
  });

  it("applies the per-kind cap after decided sources are set aside", () => {
    // Six failures, newest first: A..E fill the five slots, F waits.
    const six = ["A", "B", "C", "D", "E", "F"].map((k) => candidate(`task:${k}`));
    const first = store.sync(six, 10);
    expect(first.added.map((i) => i.sourceKey)).toEqual(six.slice(0, IDEAS_PER_KIND_MAX).map((c) => c.sourceKey));
    for (const idea of first.added) store.dismiss(idea.id, 11);
    const second = store.sync(six, 12);
    expect(second.added.map((i) => i.sourceKey)).toEqual(["task:F"]);
    expect(second.retired).toEqual([]);
  });

  it("keeps a waiting card when newer sources arrive past the cap", () => {
    const old = ["A", "B", "C", "D", "E"].map((k) => candidate(`task:${k}`));
    store.sync(old, 10);
    const newer = [candidate("task:N1"), candidate("task:N2"), ...old];
    const res = store.sync(newer, 11);
    expect(res.added).toEqual([]);
    expect(res.retired).toEqual([]);
    expect(store.list({ status: "new" }).map((i) => i.sourceKey).sort()).toEqual(old.map((c) => c.sourceKey).sort());
  });

  it("caps each kind on its own", () => {
    const tasks = Array.from({ length: 6 }, (_, i) => candidate(`task:${i}`));
    const goals = Array.from({ length: 2 }, (_, i) =>
      candidate(`goal:s${i}:1`, { kind: "resume_goal", evidence: { source: "goal", ref: `s${i}`, excerpt: "x", at: 1 } }),
    );
    const res = store.sync([...tasks, ...goals], 10);
    expect(res.added.filter((i) => i.kind === "retry_task")).toHaveLength(IDEAS_PER_KIND_MAX);
    expect(res.added.filter((i) => i.kind === "resume_goal")).toHaveLength(2);
  });

  it("accepts with compare-and-swap: a second accept or a dismiss after it throws", () => {
    store.sync([candidate("task:a")], 10);
    const a = store.list()[0]!;
    const claimed = store.claimForAccept(a.id, "edited prompt", 11);
    expect(claimed).toMatchObject({ status: "accepted", prompt: "edited prompt", decidedAt: 11 });
    expect(() => store.claimForAccept(a.id, null, 12)).toThrow(IdeaStateError);
    expect(() => store.dismiss(a.id, 12)).toThrow(IdeaStateError);
  });

  it("release puts a claimed idea without a task back to new with its old prompt", () => {
    store.sync([candidate("task:a")], 10);
    const a = store.list()[0]!;
    store.claimForAccept(a.id, "edited", 11);
    store.release(a.id, a.prompt, 12);
    expect(store.get(a.id)).toMatchObject({ status: "new", prompt: a.prompt, decidedAt: null });
  });

  it("dismiss is idempotent and returns null for an unknown id", () => {
    store.sync([candidate("task:a")], 10);
    const a = store.list()[0]!;
    expect(store.dismiss(a.id, 11)?.status).toBe("dismissed");
    expect(store.dismiss(a.id, 12)).toMatchObject({ status: "dismissed", decidedAt: 11 });
    expect(store.dismiss("nope")).toBeNull();
    expect(store.claimForAccept("nope", null)).toBeNull();
  });

  it("filters the list by status", () => {
    store.sync([candidate("task:a"), candidate("task:b")], 10);
    const a = store.list().find((i) => i.sourceKey === "task:a")!;
    store.dismiss(a.id, 11);
    expect(store.list({ status: "dismissed" }).map((i) => i.id)).toEqual([a.id]);
    expect(store.list({ status: ["new", "dismissed"] })).toHaveLength(2);
  });

  it("shares tasks.sqlite with the task queue without touching its schema", () => {
    const file = join(tmp, "tasks.sqlite");
    const tasks = new TaskStore({ dbFile: file });
    try {
      const t = tasks.create({ userMessage: "hello", origin: "cli", maxAttempts: 1 });
      store.sync([candidate(`task:${t.id}`)], 10);
      expect(tasks.get(t.id)?.userMessage).toBe("hello");
      expect(store.list()).toHaveLength(1);
    } finally {
      tasks.close();
    }
  });
});
