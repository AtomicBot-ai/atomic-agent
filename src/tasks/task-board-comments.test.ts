import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskStore } from "./task-store.js";
import {
  BOARD_COMMENT_MAX_LENGTH,
  BOARD_COMMENTS_KEPT_PER_TASK,
  validateBoardComment,
} from "./task-board-comments.js";

/** ATO-2497: a card keeps a thread of comments, not one overwritten note. */
describe("TaskStore board comments", () => {
  let tmp: string;
  let dbFile: string;
  let store: TaskStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-board-comments-"));
    dbFile = join(tmp, "tasks.sqlite");
    store = new TaskStore({ dbFile });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const create = (sessionId = "s-1") =>
    store.create({ sessionId, userMessage: "do it", origin: "cli", maxAttempts: 1 });

  it("keeps every comment, newest first, across opens", () => {
    const t = create();
    expect(store.boardCommentsUnavailable).toBeNull();
    store.addBoardComment(t.id, { author: "agent", kind: "comment", text: "started" }, 1_000);
    store.addBoardComment(t.id, { author: "person", kind: "comment", text: "thanks" }, 2_000);
    store.addBoardComment(t.id, { author: "agent", kind: "review", text: "please check" }, 3_000);
    store.close();
    store = new TaskStore({ dbFile });
    const thread = store.listBoardComments(t.id);
    expect(thread.map((c) => [c.author, c.kind, c.text])).toEqual([
      ["agent", "review", "please check"],
      ["person", "comment", "thanks"],
      ["agent", "comment", "started"],
    ]);
    expect(store.boardCommentCounts().get(t.id)).toBe(3);
  });

  it("orders comments written in the same millisecond by when they were added", () => {
    const t = create();
    store.addBoardComment(t.id, { author: "agent", kind: "comment", text: "first" }, 5_000);
    store.addBoardComment(t.id, { author: "agent", kind: "comment", text: "second" }, 5_000);
    expect(store.listBoardComments(t.id).map((c) => c.text)).toEqual(["second", "first"]);
  });

  it("answers null for an unknown task and writes nothing", () => {
    expect(store.addBoardComment("nope", { author: "agent", kind: "comment", text: "x" })).toBeNull();
    expect(store.boardCommentCounts().size).toBe(0);
  });

  it("drops the oldest comments beyond the per-card bound", () => {
    const t = create();
    for (let i = 0; i < BOARD_COMMENTS_KEPT_PER_TASK + 3; i += 1) {
      store.addBoardComment(t.id, { author: "agent", kind: "comment", text: `c${i}` }, 1_000 + i);
    }
    expect(store.boardCommentCounts().get(t.id)).toBe(BOARD_COMMENTS_KEPT_PER_TASK);
    const oldest = store.listBoardComments(t.id, BOARD_COMMENTS_KEPT_PER_TASK).at(-1);
    expect(oldest?.text).toBe("c3");
  });

  it("removes a closed incognito chat's comments with its tasks (ATO-586)", () => {
    const gone = create("incognito");
    const kept = create("other");
    store.addBoardComment(gone.id, { author: "agent", kind: "comment", text: "secret" });
    store.addBoardComment(kept.id, { author: "agent", kind: "comment", text: "fine" });
    store.removeForSession("incognito");
    expect(store.listBoardComments(gone.id)).toEqual([]);
    expect(store.listBoardComments(kept.id).map((c) => c.text)).toEqual(["fine"]);
  });
});

describe("validateBoardComment", () => {
  it("trims, and refuses empty, non-string and overlong text", () => {
    expect(validateBoardComment("  hello  ")).toEqual({ text: "hello" });
    expect(validateBoardComment("   ")).toEqual({ error: "text must not be empty" });
    expect(validateBoardComment(3)).toEqual({ error: "text must be a string" });
    expect(validateBoardComment("x".repeat(BOARD_COMMENT_MAX_LENGTH + 1))).toHaveProperty("error");
    expect(validateBoardComment("x".repeat(BOARD_COMMENT_MAX_LENGTH))).toHaveProperty("text");
  });
});
