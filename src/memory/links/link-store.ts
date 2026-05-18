import type Database from "better-sqlite3";

/**
 * Memory-v2 phase 2. Link graph store.
 *
 * One row per `(from_id, to_id, kind)` triple. The graph is
 * **directed but expandable in both directions** — `expand()` walks
 * outgoing and incoming edges at each BFS hop so the recall layer
 * can surface "things this memory caused" AND "things that caused
 * this memory" without the LLM having to author both edges.
 *
 * Owns its slice of the SQLite handle but not the lifecycle: the
 * surrounding `MemoryStore` opens the DB and runs migrations; this
 * store just prepares its own statements. `foreign_keys=ON` is
 * required for the cascade to fire — `MemoryStore` already enables
 * it on every connection.
 */
export type LinkKind =
  | "RELATES_TO"
  | "CAUSED_BY"
  | "REFERENCES"
  | "CONTRADICTS"
  | "DUPLICATES"
  | "SUPERSEDES";

/**
 * Allowed link kinds — keep small and uppercase. Adding new kinds
 * requires extending both this set and the link-generator grammar.
 * The parser rejects anything outside this list so a malformed LLM
 * output can never sneak a free-form tag in.
 */
export const LINK_KINDS: readonly LinkKind[] = [
  "RELATES_TO",
  "CAUSED_BY",
  "REFERENCES",
  "CONTRADICTS",
  "DUPLICATES",
  "SUPERSEDES",
] as const;

export function isLinkKind(raw: string): raw is LinkKind {
  return (LINK_KINDS as readonly string[]).includes(raw);
}

export interface LinkRow {
  fromId: number;
  toId: number;
  kind: LinkKind;
  weight: number;
  createdAt: number;
}

export interface LinkStoreOptions {
  db: Database.Database;
  /** Defaults to `Date.now`. Injectable for tests. */
  now?: () => number;
}

export class LinkValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "LinkValidationError";
  }
}

export interface AddLinkInput {
  fromId: number;
  toId: number;
  kind: LinkKind;
  /** Defaults to 1.0. Clamped to `[0, 1]`. */
  weight?: number;
}

export interface ExpandOptions {
  /** Max BFS depth, ≥ 1. Default 1 (one hop). Clamped to 3. */
  depth?: number;
  /** Stop expansion when this many unique ids accumulate. Default 50. */
  maxExpanded?: number;
  /** Restrict to these kinds. Default: all kinds. */
  kinds?: readonly LinkKind[];
  /** Skip self-loops in the seed (defensive — store rejects them already). */
  excludeSelfLoops?: boolean;
}

export class LinkStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly upsertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly listOutgoingStmt: Database.Statement;
  private readonly listIncomingStmt: Database.Statement;
  private readonly listOutgoingAllStmt: Database.Statement;
  private readonly listIncomingAllStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly deleteAllForMemoryStmt: Database.Statement;

  constructor(opts: LinkStoreOptions) {
    this.db = opts.db;
    this.now = opts.now ?? Date.now;
    this.upsertStmt = this.db.prepare(
      `INSERT INTO memory_links (from_id, to_id, kind, weight, created_at)
       VALUES (@from_id, @to_id, @kind, @weight, @created_at)
       ON CONFLICT(from_id, to_id, kind) DO UPDATE SET
         weight = excluded.weight,
         created_at = excluded.created_at`,
    );
    this.getStmt = this.db.prepare(
      `SELECT from_id, to_id, kind, weight, created_at
         FROM memory_links
        WHERE from_id = ? AND to_id = ? AND kind = ?`,
    );
    this.listOutgoingStmt = this.db.prepare(
      `SELECT from_id, to_id, kind, weight, created_at
         FROM memory_links
        WHERE from_id = ? AND kind IN (SELECT value FROM json_each(?))
        ORDER BY weight DESC, created_at DESC`,
    );
    this.listIncomingStmt = this.db.prepare(
      `SELECT from_id, to_id, kind, weight, created_at
         FROM memory_links
        WHERE to_id = ? AND kind IN (SELECT value FROM json_each(?))
        ORDER BY weight DESC, created_at DESC`,
    );
    this.listOutgoingAllStmt = this.db.prepare(
      `SELECT from_id, to_id, kind, weight, created_at
         FROM memory_links
        WHERE from_id = ?
        ORDER BY weight DESC, created_at DESC`,
    );
    this.listIncomingAllStmt = this.db.prepare(
      `SELECT from_id, to_id, kind, weight, created_at
         FROM memory_links
        WHERE to_id = ?
        ORDER BY weight DESC, created_at DESC`,
    );
    this.countStmt = this.db.prepare(
      `SELECT COUNT(*) AS count FROM memory_links`,
    );
    this.deleteStmt = this.db.prepare(
      `DELETE FROM memory_links WHERE from_id = ? AND to_id = ? AND kind = ?`,
    );
    this.deleteAllForMemoryStmt = this.db.prepare(
      `DELETE FROM memory_links WHERE from_id = ? OR to_id = ?`,
    );
  }

  add(input: AddLinkInput, now: number = this.now()): LinkRow {
    if (!Number.isInteger(input.fromId) || input.fromId <= 0) {
      throw new LinkValidationError(
        "fromId",
        `expected positive integer, got ${input.fromId}`,
      );
    }
    if (!Number.isInteger(input.toId) || input.toId <= 0) {
      throw new LinkValidationError(
        "toId",
        `expected positive integer, got ${input.toId}`,
      );
    }
    if (input.fromId === input.toId) {
      throw new LinkValidationError(
        "toId",
        "self-loop rejected (from_id == to_id)",
      );
    }
    if (!isLinkKind(input.kind)) {
      throw new LinkValidationError(
        "kind",
        `unknown link kind ${JSON.stringify(input.kind)}; ` +
          `allowed: ${LINK_KINDS.join(", ")}`,
      );
    }
    const weight = clampUnit(input.weight ?? 1.0);
    this.upsertStmt.run({
      from_id: input.fromId,
      to_id: input.toId,
      kind: input.kind,
      weight,
      created_at: now,
    });
    return {
      fromId: input.fromId,
      toId: input.toId,
      kind: input.kind,
      weight,
      createdAt: now,
    };
  }

  get(fromId: number, toId: number, kind: LinkKind): LinkRow | null {
    const row = this.getStmt.get(fromId, toId, kind) as
      | {
          from_id: number;
          to_id: number;
          kind: LinkKind;
          weight: number;
          created_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      fromId: row.from_id,
      toId: row.to_id,
      kind: row.kind,
      weight: row.weight,
      createdAt: row.created_at,
    };
  }

  listOutgoing(
    fromId: number,
    kinds?: readonly LinkKind[],
  ): readonly LinkRow[] {
    const rows = kinds && kinds.length > 0
      ? (this.listOutgoingStmt.all(fromId, JSON.stringify(kinds)) as Array<{
          from_id: number;
          to_id: number;
          kind: LinkKind;
          weight: number;
          created_at: number;
        }>)
      : (this.listOutgoingAllStmt.all(fromId) as Array<{
          from_id: number;
          to_id: number;
          kind: LinkKind;
          weight: number;
          created_at: number;
        }>);
    return rows.map(rowToLink);
  }

  listIncoming(
    toId: number,
    kinds?: readonly LinkKind[],
  ): readonly LinkRow[] {
    const rows = kinds && kinds.length > 0
      ? (this.listIncomingStmt.all(toId, JSON.stringify(kinds)) as Array<{
          from_id: number;
          to_id: number;
          kind: LinkKind;
          weight: number;
          created_at: number;
        }>)
      : (this.listIncomingAllStmt.all(toId) as Array<{
          from_id: number;
          to_id: number;
          kind: LinkKind;
          weight: number;
          created_at: number;
        }>);
    return rows.map(rowToLink);
  }

  remove(fromId: number, toId: number, kind: LinkKind): boolean {
    const r = this.deleteStmt.run(fromId, toId, kind) as { changes: number };
    return r.changes > 0;
  }

  /**
   * Wipe every edge that touches `memoryId`. Normally unnecessary —
   * the FK cascade fires on `memories.remove(id)` — but useful when
   * the operator wants to reset just the graph without dropping the
   * memory itself.
   */
  removeAllForMemory(memoryId: number): number {
    const r = this.deleteAllForMemoryStmt.run(memoryId, memoryId) as {
      changes: number;
    };
    return r.changes;
  }

  count(): number {
    const row = this.countStmt.get() as { count: number };
    return row.count;
  }

  /**
   * Breadth-first traversal from `seedIds`. Walks **both directions**
   * at each hop (outgoing + incoming) so the recall layer can surface
   * related memories without forcing the LLM to author symmetric
   * edges.
   *
   * Returns ids in BFS order, with seeds **excluded** from the
   * result. Deduplicated. Bounded by `depth` (default 1, max 3) and
   * `maxExpanded` (default 50). When the cap is hit, the traversal
   * stops mid-hop — last-in-rank entries are dropped, so weight-
   * ordered hops produce stable top-N expansions.
   *
   * Empty seed ⇒ empty result.
   */
  expand(seedIds: readonly number[], opts: ExpandOptions = {}): number[] {
    if (seedIds.length === 0) return [];
    const depth = Math.max(1, Math.min(3, Math.floor(opts.depth ?? 1)));
    const maxExpanded = Math.max(1, opts.maxExpanded ?? 50);
    const kinds = opts.kinds;

    const seen = new Set<number>();
    for (const id of seedIds) seen.add(id);
    const result: number[] = [];
    let frontier = [...seedIds];

    for (let d = 0; d < depth; d += 1) {
      const next: number[] = [];
      for (const node of frontier) {
        const outgoing = this.listOutgoing(node, kinds);
        const incoming = this.listIncoming(node, kinds);
        for (const e of outgoing) {
          if (seen.has(e.toId)) continue;
          if (opts.excludeSelfLoops && e.toId === node) continue;
          seen.add(e.toId);
          result.push(e.toId);
          next.push(e.toId);
          if (result.length >= maxExpanded) return result;
        }
        for (const e of incoming) {
          if (seen.has(e.fromId)) continue;
          if (opts.excludeSelfLoops && e.fromId === node) continue;
          seen.add(e.fromId);
          result.push(e.fromId);
          next.push(e.fromId);
          if (result.length >= maxExpanded) return result;
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return result;
  }
}

function rowToLink(row: {
  from_id: number;
  to_id: number;
  kind: LinkKind;
  weight: number;
  created_at: number;
}): LinkRow {
  return {
    fromId: row.from_id,
    toId: row.to_id,
    kind: row.kind,
    weight: row.weight,
    createdAt: row.created_at,
  };
}

function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 1.0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
