import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BOARD_DEPENDENCIES_MAX, checkDependencies } from "./task-board-deps.js";
import { TaskStore } from "./task-store.js";

/** ATO-2498: cards that wait on other cards. */
describe("checkDependencies", () => {
  const exists = (id: string) => id.startsWith("t-");
  const none = new Map<string, string[]>();

  it("keeps unique trimmed ids, sorted", () => {
    expect(checkDependencies("t-a", [" t-c", "t-b", "t-c"], exists, none)).toEqual({ dependsOn: ["t-b", "t-c"] });
    expect(checkDependencies("t-a", [], exists, none)).toEqual({ dependsOn: [] });
  });

  it("refuses a non-list, itself, a missing task and too many", () => {
    expect(checkDependencies("t-a", "t-b", exists, none)).toHaveProperty("error");
    expect(checkDependencies("t-a", [3], exists, none)).toHaveProperty("error");
    expect(checkDependencies("t-a", ["t-a"], exists, none)).toEqual({ error: "a card cannot wait on itself" });
    expect(checkDependencies("t-a", ["x-1"], exists, none)).toEqual({ error: "task not found: x-1" });
    const many = Array.from({ length: BOARD_DEPENDENCIES_MAX + 1 }, (_, i) => `t-${i}`);
    expect(checkDependencies("t-a", many, exists, none)).toHaveProperty("error");
  });

  it("refuses a cycle through cards already linked", () => {
    const edges = new Map([
      ["t-b", ["t-c"]],
      ["t-c", ["t-a"]],
    ]);
    expect(checkDependencies("t-a", ["t-b"], exists, edges)).toEqual({
      error: "that would make the cards wait on each other",
    });
    expect(checkDependencies("t-d", ["t-b"], exists, edges)).toEqual({ dependsOn: ["t-b"] });
  });
});

describe("TaskStore card dependencies", () => {
  let tmp: string;
  let store: TaskStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-board-deps-"));
    store = new TaskStore({ dbFile: join(tmp, "tasks.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const create = (sessionId = "s-1") =>
    store.create({ sessionId, userMessage: "x", origin: "cli", maxAttempts: 1 });

  it("waits on a dependency until its card is in Done", () => {
    const a = create();
    const b = create();
    store.setBoardDependencies(b.id, [a.id]);
    expect(store.boardWaitingOn(b.id)).toEqual([a.id]);
    store.updateBoardCard(a.id, { lane: "done" });
    expect(store.boardWaitingOn(b.id)).toEqual([]);
    expect(store.boardDependencies(b.id)).toEqual([a.id]);
    expect(store.boardDependencyMap().get(b.id)).toEqual([a.id]);
  });

  it("answers null for an unknown task and replaces the list on each set", () => {
    const a = create();
    const b = create();
    const c = create();
    expect(store.setBoardDependencies("missing", [a.id])).toBeNull();
    store.setBoardDependencies(c.id, [a.id, b.id]);
    store.setBoardDependencies(c.id, [b.id]);
    expect(store.boardDependencies(c.id)).toEqual([b.id]);
  });

  it("stops waiting on a task that was removed, and drops its edges", () => {
    const a = create("s-gone");
    const b = create();
    store.setBoardDependencies(b.id, [a.id]);
    store.removeForSession("s-gone");
    expect(store.boardWaitingOn(b.id)).toEqual([]);
    expect(store.boardDependencies(b.id)).toEqual([]);
  });
});
