import type Database from "better-sqlite3";

/** Most cards one card may wait on. */
export const BOARD_DEPENDENCIES_MAX = 20;

/**
 * Dependencies between cards on the task board (ATO-2498), the way
 * Linear's "blocked by", GitHub Projects' tracked issues and the
 * OpenClaw Workboard link cards: a card that depends on others is not
 * run by the scheduler until each of them is done. One row per edge in
 * `tasks.sqlite` (`task_board_deps`), added outside the numbered
 * migrations like `task_board`. When the table cannot be added the
 * board keeps no dependencies for this open: nothing waits, as before.
 */
export class TaskBoardDeps {
  readonly unavailable: string | null;
  private readonly forStmt: Database.Statement | null = null;
  private readonly allStmt: Database.Statement | null = null;
  private readonly clearStmt: Database.Statement | null = null;
  private readonly insertStmt: Database.Statement | null = null;
  private readonly pruneStmt: Database.Statement | null = null;
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.unavailable = ensureDepsTable(db);
    if (this.unavailable !== null) return;
    this.forStmt = db.prepare(
      `SELECT depends_on FROM task_board_deps WHERE task_id = ? ORDER BY depends_on`,
    );
    this.allStmt = db.prepare(`SELECT task_id, depends_on FROM task_board_deps`);
    this.clearStmt = db.prepare(`DELETE FROM task_board_deps WHERE task_id = ?`);
    this.insertStmt = db.prepare(
      `INSERT OR IGNORE INTO task_board_deps (task_id, depends_on) VALUES (?, ?)`,
    );
    this.pruneStmt = db.prepare(
      `DELETE FROM task_board_deps
        WHERE task_id NOT IN (SELECT id FROM tasks)
           OR depends_on NOT IN (SELECT id FROM tasks)`,
    );
  }

  /** The cards `taskId` waits on, sorted. */
  dependsOn(taskId: string): string[] {
    if (!this.forStmt) return [];
    return (this.forStmt.all(taskId) as { depends_on: string }[]).map((r) => r.depends_on);
  }

  /** Every edge, as task id to the ids it waits on. */
  all(): Map<string, string[]> {
    const edges = new Map<string, string[]>();
    if (!this.allStmt) return edges;
    for (const row of this.allStmt.all() as { task_id: string; depends_on: string }[]) {
      const list = edges.get(row.task_id) ?? [];
      list.push(row.depends_on);
      edges.set(row.task_id, list);
    }
    return edges;
  }

  /**
   * Replace what `taskId` waits on with `dependsOn` (already checked by
   * `checkDependencies`). Returns `false` when dependencies are off.
   */
  set(taskId: string, dependsOn: readonly string[]): boolean {
    const clear = this.clearStmt;
    const insert = this.insertStmt;
    if (!clear || !insert) return false;
    this.db.transaction(() => {
      clear.run(taskId);
      for (const id of dependsOn) insert.run(taskId, id);
    })();
    return true;
  }

  /** Drop edges whose either end is gone (ATO-586). Best effort. */
  pruneOrphans(): void {
    try {
      this.pruneStmt?.run();
    } catch {
      // Kept until the next prune; an edge to a gone task never waits.
    }
  }
}

/**
 * Check a new dependency list for `taskId`: unique ids of existing
 * tasks, not itself, at most `BOARD_DEPENDENCIES_MAX`, and no cycle
 * through the edges already stored (`edges`). Returns the sorted list,
 * or a sentence for the caller to answer with.
 */
export function checkDependencies(
  taskId: string,
  raw: unknown,
  exists: (id: string) => boolean,
  edges: ReadonlyMap<string, readonly string[]>,
): { dependsOn: string[] } | { error: string } {
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string" || id.trim() === "")) {
    return { error: "dependsOn must be a list of task ids" };
  }
  const ids = [...new Set((raw as string[]).map((id) => id.trim()))].sort();
  if (ids.length > BOARD_DEPENDENCIES_MAX) {
    return { error: `a card can wait on at most ${BOARD_DEPENDENCIES_MAX} cards` };
  }
  if (ids.includes(taskId)) return { error: "a card cannot wait on itself" };
  const missing = ids.filter((id) => !exists(id));
  if (missing.length > 0) return { error: `task not found: ${missing.join(", ")}` };
  // A cycle: some new dependency already waits, directly or not, on taskId.
  const seen = new Set<string>();
  const stack = [...ids];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (next === taskId) return { error: "that would make the cards wait on each other" };
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(edges.get(next) ?? []));
  }
  return { dependsOn: ids };
}

function ensureDepsTable(db: Database.Database): string | null {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_board_deps (
        task_id    TEXT NOT NULL,
        depends_on TEXT NOT NULL,
        PRIMARY KEY (task_id, depends_on)
      );
    `);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
