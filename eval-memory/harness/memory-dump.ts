/**
 * Read-only snapshot of `<stateDir>/memory.sqlite` after a run.
 *
 * Used by the paired runner (E2) to summarise what each profile
 * (ON vs OFF) accumulated, and by ad-hoc debugging when an
 * experiment behaves unexpectedly.
 *
 * Best-effort — missing tables (config v1, schema mid-migration)
 * return empty arrays. Never throws on schema absence. Always opens
 * the database in **readonly** mode so a parallel agent process can
 * still hold a writer handle.
 */

import { existsSync } from "node:fs";
import Database from "better-sqlite3";

export interface ProfileFactDump {
  id: number;
  key: string;
  value: string;
  pinned: boolean;
  keywords: string | null;
  validFrom: number;
  supersededBy: number | null;
}

export interface MemoryDump {
  id: number;
  content: string;
  tags: string[];
  source: string | null;
  workingDir: string | null;
  recallCount: number;
  createdAt: number;
  consolidatedInto: number | null;
}

export interface LessonDump {
  id: number;
  activation: string;
  principle: string;
  tags: string[];
  parentIds: number[];
  status: string;
  successCount: number;
  failureCount: number;
  createdAt: number;
}

export interface LinkDump {
  fromId: number;
  toId: number;
  kind: string;
  weight: number;
}

export interface EmbeddingDump {
  memoryId: number;
  model: string;
  dim: number;
}

export interface MemorySnapshot {
  profileFacts: ProfileFactDump[];
  memories: MemoryDump[];
  lessons: LessonDump[];
  links: LinkDump[];
  embeddings: EmbeddingDump[];
}

/** Returns an empty snapshot when the file is missing. */
export function readMemorySnapshot(dbFile: string): MemorySnapshot {
  if (!existsSync(dbFile)) return emptySnapshot();
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    return {
      profileFacts: readProfileFacts(db),
      memories: readMemories(db),
      lessons: readLessons(db),
      links: readLinks(db),
      embeddings: readEmbeddings(db),
    };
  } finally {
    db.close();
  }
}

function emptySnapshot(): MemorySnapshot {
  return { profileFacts: [], memories: [], lessons: [], links: [], embeddings: [] };
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function readProfileFacts(db: Database.Database): ProfileFactDump[] {
  if (!tableExists(db, "profile_facts")) return [];
  try {
    const rows = db
      .prepare(
        "SELECT id, key, value, pinned, keywords, valid_from, superseded_by FROM profile_facts ORDER BY id ASC",
      )
      .all() as Array<{
      id: number;
      key: string;
      value: string;
      pinned: number;
      keywords: string | null;
      valid_from: number;
      superseded_by: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      value: r.value,
      pinned: r.pinned === 1,
      keywords: r.keywords,
      validFrom: r.valid_from,
      supersededBy: r.superseded_by,
    }));
  } catch {
    return [];
  }
}

function readMemories(db: Database.Database): MemoryDump[] {
  if (!tableExists(db, "memories")) return [];
  try {
    const rows = db
      .prepare(
        "SELECT id, content, tags, source, working_dir, recall_count, created_at, consolidated_into FROM memories ORDER BY id ASC",
      )
      .all() as Array<{
      id: number;
      content: string;
      tags: string | null;
      source: string | null;
      working_dir: string | null;
      recall_count: number;
      created_at: number;
      consolidated_into: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      tags: parseJsonArray(r.tags),
      source: r.source,
      workingDir: r.working_dir,
      recallCount: r.recall_count,
      createdAt: r.created_at,
      consolidatedInto: r.consolidated_into,
    }));
  } catch {
    return [];
  }
}

function readLessons(db: Database.Database): LessonDump[] {
  if (!tableExists(db, "lessons")) return [];
  try {
    const rows = db
      .prepare(
        "SELECT id, activation, principle, tags, parent_ids, status, success_count, failure_count, created_at FROM lessons ORDER BY id ASC",
      )
      .all() as Array<{
      id: number;
      activation: string;
      principle: string;
      tags: string | null;
      parent_ids: string | null;
      status: string;
      success_count: number;
      failure_count: number;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      activation: r.activation,
      principle: r.principle,
      tags: parseJsonArray(r.tags),
      parentIds: parseJsonArray(r.parent_ids).map((x) => Number(x)).filter((n) => Number.isInteger(n)),
      status: r.status,
      successCount: r.success_count,
      failureCount: r.failure_count,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

function readLinks(db: Database.Database): LinkDump[] {
  if (!tableExists(db, "memory_links")) return [];
  try {
    const rows = db
      .prepare(
        "SELECT from_id, to_id, kind, weight FROM memory_links ORDER BY from_id ASC, to_id ASC",
      )
      .all() as Array<{ from_id: number; to_id: number; kind: string; weight: number }>;
    return rows.map((r) => ({ fromId: r.from_id, toId: r.to_id, kind: r.kind, weight: r.weight }));
  } catch {
    return [];
  }
}

function readEmbeddings(db: Database.Database): EmbeddingDump[] {
  if (!tableExists(db, "memory_embeddings")) return [];
  try {
    const rows = db
      .prepare("SELECT memory_id, model, dim FROM memory_embeddings ORDER BY memory_id ASC")
      .all() as Array<{ memory_id: number; model: string; dim: number }>;
    return rows.map((r) => ({ memoryId: r.memory_id, model: r.model, dim: r.dim }));
  } catch {
    return [];
  }
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => String(x));
  } catch {
    return [];
  }
}
