import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "../native/load-better-sqlite3.js";
import { TaskStore } from "./task-store.js";

/** ATO-2257: the board's lane, note and assignee, stored beside the queue. */
describe("TaskStore task board", () => {
  let tmp: string;
  let dbFile: string;
  let store: TaskStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-task-board-"));
    dbFile = join(tmp, "tasks.sqlite");
    store = new TaskStore({ dbFile });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const create = (sessionId = "s-1") =>
    store.create({ sessionId, userMessage: "do it", origin: "cli", maxAttempts: 1 });

  it("shows every task in the lane its status gives until a card is moved", () => {
    const waiting = create();
    const running = create();
    store.markRunning(running.id, 1_000);
    expect(store.boardUnavailable).toBeNull();
    const lanes = Object.fromEntries(store.boardCards().map((c) => [c.task.id, c.lane]));
    expect(lanes).toEqual({ [waiting.id]: "todo", [running.id]: "doing" });
  });

  it("moves a card without touching the task's status, and keeps it across opens", () => {
    const t = create();
    store.markRunning(t.id, 1_000);
    store.markCompleted(t.id, 1_500);
    const moved = store.updateBoardCard(
      t.id,
      { lane: "review", note: "check the diff", assignee: "reviewer" },
      2_000,
    );
    expect(moved).toMatchObject({ lane: "review", laneSource: "board", note: "check the diff", assignee: "reviewer" });
    expect(store.get(t.id)?.status).toBe("completed");

    store.close();
    store = new TaskStore({ dbFile });
    const [card] = store.boardCards();
    expect(card).toMatchObject({ lane: "review", note: "check the diff", assignee: "reviewer", boardUpdatedAt: 2_000 });
  });

  it("changes only the fields a patch names; a note edit does not re-pin the lane", () => {
    const t = create();
    store.updateBoardCard(t.id, { lane: "done" }, 100);
    store.updateBoardCard(t.id, { note: "later" }, 5_000);
    store.markRunning(t.id, 1_000);
    // The run started after the lane was set (100), so the card follows the status,
    // even though the note was written after the run started.
    const [card] = store.boardCards();
    expect(card).toMatchObject({ lane: "doing", laneSource: "status", note: "later" });
  });

  it("clears a lane back to the status, and drops an empty entry", () => {
    const t = create();
    store.updateBoardCard(t.id, { lane: "blocked", note: "waiting on keys" }, 100);
    store.updateBoardCard(t.id, { lane: null }, 200);
    expect(store.boardCards()[0]).toMatchObject({ lane: "todo", laneSource: "status", note: "waiting on keys" });
    store.updateBoardCard(t.id, { note: null }, 300);
    expect(store.boardCards()[0]).toMatchObject({ note: null, boardUpdatedAt: null });
  });

  it("answers null for an unknown task", () => {
    expect(store.updateBoardCard("missing", { lane: "done" })).toBeNull();
  });

  it("drops the notes of tasks removed with their session", () => {
    const secret = create("s-incognito");
    const kept = create("s-2");
    store.updateBoardCard(secret.id, { note: "private" }, 100);
    store.updateBoardCard(kept.id, { note: "keep me" }, 100);
    store.removeForSession("s-incognito");
    store.close();
    // The orphan row is gone from the file, not only hidden from the cards.
    const raw = new Database(dbFile);
    const notes = raw.prepare(`SELECT note FROM task_board`).all() as Array<{ note: string }>;
    raw.close();
    expect(notes.map((n) => n.note)).toEqual(["keep me"]);
    store = new TaskStore({ dbFile });
    expect(store.updateBoardCard(secret.id, { note: "x" })).toBeNull();
  });
});
