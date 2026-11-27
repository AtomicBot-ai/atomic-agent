import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskStore, type TaskRecord } from "../tasks/index.js";
import {
  formatBoard,
  handleAssign,
  handleBoard,
  handleComment,
  handleDepends,
  handleMove,
} from "./task-board-command.js";

/** ATO-2498: the task board from the terminal (`atag task board`, `atag task move`, ...). */
describe("task board commands", () => {
  let tmp: string;
  let dbFile: string;
  let out: string[];
  let err: string[];
  const open = () => new TaskStore({ dbFile });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-task-board-cli-"));
    dbFile = join(tmp, "tasks.sqlite");
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  const create = (message: string): TaskRecord => {
    const store = open();
    try {
      return store.create({ sessionId: "s-1", userMessage: message, origin: "cli", maxAttempts: 1 });
    } finally {
      store.close();
    }
  };
  const read = <T>(fn: (store: TaskStore) => T): T => {
    const store = open();
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };

  it("moves a card to a lane with a note and leaves the status alone", () => {
    const task = create("write the notes");
    expect(handleMove([task.id, "review", "--note", "check it"], open)).toBe(0);
    const card = read((s) => s.boardCards().find((c) => c.task.id === task.id));
    expect(card).toMatchObject({ lane: "review", note: "check it", task: { status: "pending" } });
  });

  it("refuses an unknown lane or task with a plain message", () => {
    const task = create("x");
    expect(handleMove([task.id, "archive"], open)).toBe(1);
    expect(err.join("")).toMatch(/lane/);
    expect(handleMove(["missing", "done"], open)).toBe(1);
    expect(err.join("")).toMatch(/task not found: missing/);
    expect(handleMove([task.id], open)).toBe(1);
  });

  it("assigns and unassigns a profile", () => {
    const task = create("x");
    expect(handleAssign([task.id, "writer"], open)).toBe(0);
    expect(read((s) => s.boardEntry(task.id)?.assignee)).toBe("writer");
    expect(handleAssign([task.id, "none"], open)).toBe(0);
    expect(read((s) => s.boardEntry(task.id)?.assignee ?? null)).toBeNull();
  });

  it("adds a person's comment and prints the thread oldest first", () => {
    const task = create("x");
    expect(handleComment([task.id, "first", "words"], open)).toBe(0);
    expect(handleComment([task.id, "second"], open)).toBe(0);
    out = [];
    expect(handleComment([task.id], open)).toBe(0);
    const printed = out.join("");
    expect(printed.indexOf("first words")).toBeLessThan(printed.indexOf("second"));
    expect(printed).toMatch(/person\/comment/);
  });

  it("sets, shows and clears what a card waits on, and refuses a cycle", () => {
    const a = create("a");
    const b = create("b");
    expect(handleDepends([b.id, a.id], open)).toBe(0);
    expect(read((s) => s.boardWaitingOn(b.id))).toEqual([a.id]);
    expect(handleDepends([a.id, b.id], open)).toBe(1);
    expect(err.join("")).toMatch(/wait on each other/);
    expect(handleDepends([b.id, "none"], open)).toBe(0);
    expect(read((s) => s.boardDependencies(b.id))).toEqual([]);
  });

  it("prints the board by lane, and as JSON with --json", () => {
    const a = create("first task");
    const b = create("second task");
    handleDepends([b.id, a.id], open);
    handleAssign([b.id, "writer"], open);
    out = [];
    expect(handleBoard([], open)).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/^To do \(2\)/);
    expect(text).toContain(`@writer; waits on ${a.id}`);
    out = [];
    expect(handleBoard(["--json"], open)).toBe(0);
    const json = JSON.parse(out.join("")) as { id: string; lane: string; waitingOn: string[] }[];
    expect(json.find((c) => c.id === b.id)).toMatchObject({ lane: "todo", waitingOn: [a.id] });
    expect(handleBoard(["--limit", "0"], open)).toBe(1);
  });

  it("shortens a long request on its line", () => {
    const task = create("x".repeat(100));
    const cards = read((s) => s.boardCards());
    const text = formatBoard(cards, () => []);
    expect(text).toContain(`${task.id}  ${"x".repeat(57)}...`);
  });
});
