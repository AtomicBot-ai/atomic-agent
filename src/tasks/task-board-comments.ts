import type Database from "better-sqlite3";

/**
 * Who wrote a comment on a card (ATO-2497): the agent running the task
 * (its `tasks.comment`, `tasks.request_review` and `tasks.block` tools),
 * a person (the board, the CLI), or the runner itself (the failure fuse).
 */
export const BOARD_COMMENT_AUTHORS = ["agent", "person", "system"] as const;
export type BoardCommentAuthor = (typeof BOARD_COMMENT_AUTHORS)[number];

/**
 * What a comment records: plain text, a review request, a block (with
 * its reason), or the fuse stopping a task that kept failing.
 */
export const BOARD_COMMENT_KINDS = ["comment", "review", "block", "fuse"] as const;
export type BoardCommentKind = (typeof BOARD_COMMENT_KINDS)[number];

/** Longest comment a card keeps; the same bound as its note. */
export const BOARD_COMMENT_MAX_LENGTH = 2_000;
/** Comments kept per card; the oldest go when a new one is added. */
export const BOARD_COMMENTS_KEPT_PER_TASK = 200;

export interface BoardComment {
  id: number;
  taskId: string;
  author: BoardCommentAuthor;
  kind: BoardCommentKind;
  text: string;
  createdAt: number;
}

export interface BoardCommentInput {
  author: BoardCommentAuthor;
  kind: BoardCommentKind;
  text: string;
}

interface CommentRow {
  id: number;
  task_id: string;
  author: string;
  kind: string;
  text: string;
  created_at: number;
}

/**
 * The comment history of each card on the task board (ATO-2497): one
 * row per comment in `tasks.sqlite` (`task_board_comments`), the way
 * Linear, GitHub Projects and the Hermes kanban keep a thread on a card
 * rather than one note that each writer overwrites.
 *
 * Added outside the numbered migrations, like `task_board`: an older
 * binary ignores the extra table. When it cannot be added (read-only
 * file, lock not got) comments are off for this open: `list` is empty,
 * `add` answers `null`, and the rest of the board works.
 */
export class TaskBoardComments {
  readonly unavailable: string | null;
  private readonly insertStmt: Database.Statement | null = null;
  private readonly listStmt: Database.Statement | null = null;
  private readonly trimStmt: Database.Statement | null = null;
  private readonly countStmt: Database.Statement | null = null;
  private readonly pruneStmt: Database.Statement | null = null;

  constructor(db: Database.Database) {
    this.unavailable = ensureCommentsTable(db);
    if (this.unavailable !== null) return;
    this.insertStmt = db.prepare(
      `INSERT INTO task_board_comments (task_id, author, kind, text, created_at)
       VALUES (@task_id, @author, @kind, @text, @created_at)`,
    );
    // Newest first; `id` breaks ties between comments in the same ms.
    this.listStmt = db.prepare(
      `SELECT * FROM task_board_comments WHERE task_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    );
    this.trimStmt = db.prepare(
      `DELETE FROM task_board_comments WHERE task_id = @task_id AND id NOT IN (
         SELECT id FROM task_board_comments WHERE task_id = @task_id
          ORDER BY created_at DESC, id DESC LIMIT @keep)`,
    );
    this.countStmt = db.prepare(
      `SELECT task_id, COUNT(*) AS n FROM task_board_comments GROUP BY task_id`,
    );
    this.pruneStmt = db.prepare(
      `DELETE FROM task_board_comments WHERE task_id NOT IN (SELECT id FROM tasks)`,
    );
  }

  /**
   * Add a comment (text already checked, see `validateBoardComment`) and
   * drop the card's oldest beyond `BOARD_COMMENTS_KEPT_PER_TASK`. Returns
   * the stored comment, or `null` when comments are off. The caller
   * checks the task exists.
   */
  add(taskId: string, input: BoardCommentInput, now: number): BoardComment | null {
    if (!this.insertStmt || !this.trimStmt) return null;
    const result = this.insertStmt.run({
      task_id: taskId,
      author: input.author,
      kind: input.kind,
      text: input.text,
      created_at: now,
    });
    this.trimStmt.run({ task_id: taskId, keep: BOARD_COMMENTS_KEPT_PER_TASK });
    return {
      id: Number(result.lastInsertRowid),
      taskId,
      author: input.author,
      kind: input.kind,
      text: input.text,
      createdAt: now,
    };
  }

  /** The card's comments, newest first. */
  list(taskId: string, limit = 50): BoardComment[] {
    if (!this.listStmt) return [];
    const bounded = Math.max(1, Math.min(limit, BOARD_COMMENTS_KEPT_PER_TASK));
    return (this.listStmt.all(taskId, bounded) as CommentRow[]).map(rowToComment);
  }

  /** How many comments each card has, keyed by task id. */
  counts(): Map<string, number> {
    const counts = new Map<string, number>();
    if (!this.countStmt) return counts;
    for (const row of this.countStmt.all() as { task_id: string; n: number }[]) {
      counts.set(row.task_id, row.n);
    }
    return counts;
  }

  /** Drop comments whose task is gone (an incognito chat's, ATO-586). */
  pruneOrphans(): void {
    try {
      this.pruneStmt?.run();
    } catch {
      // Kept until the next prune; nothing lists comments of a gone task.
    }
  }
}

/**
 * Check a comment's text: trimmed, not empty, at most
 * `BOARD_COMMENT_MAX_LENGTH`. Returns the text to store, or an error
 * sentence for the caller to answer with.
 */
export function validateBoardComment(raw: unknown): { text: string } | { error: string } {
  if (typeof raw !== "string") return { error: "text must be a string" };
  const text = raw.trim();
  if (text.length === 0) return { error: "text must not be empty" };
  if (text.length > BOARD_COMMENT_MAX_LENGTH) {
    return { error: `text is longer than ${BOARD_COMMENT_MAX_LENGTH} characters` };
  }
  return { text };
}

function ensureCommentsTable(db: Database.Database): string | null {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_board_comments (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    TEXT NOT NULL,
        author     TEXT NOT NULL,
        kind       TEXT NOT NULL,
        text       TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_board_comments_task
        ON task_board_comments (task_id, created_at);
    `);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function rowToComment(row: CommentRow): BoardComment {
  const author = (BOARD_COMMENT_AUTHORS as readonly string[]).includes(row.author)
    ? (row.author as BoardCommentAuthor)
    : "system";
  const kind = (BOARD_COMMENT_KINDS as readonly string[]).includes(row.kind)
    ? (row.kind as BoardCommentKind)
    : "comment";
  return { id: row.id, taskId: row.task_id, author, kind, text: row.text, createdAt: row.created_at };
}
