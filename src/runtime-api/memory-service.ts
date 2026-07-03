import type {
  MemoryEntry,
  MemoryStore,
  ProfileFact,
  ProfileStore,
} from "../memory/index.js";
import type {
  Lesson,
  LessonIndexEntry,
  LessonStore,
} from "../memory/lessons/index.js";
import type {
  Procedure,
  ProcedureIndexEntry,
  ProcedureStore,
} from "../memory/procedures/index.js";
import type {
  ExpandOptions,
  LinkRow,
  LinkStore,
} from "../memory/links/index.js";
import type { VoteEventRow, VoteStore } from "../memory/voting/index.js";

import { RuntimeApiError } from "./runtime-api-error.js";

/**
 * Read-only projection over the six memory-fabric stores. Every function is
 * pure inspection — no writes — so both the sidecar `memory.*` handlers and
 * any future HTTP route share one drift-free source of truth (mirrors the
 * TUI Memory tab invariant: the agent itself mutates memory via
 * tools/reflection, never the protocol). Native store entity types
 * (`ProfileFact`, `MemoryEntry`, …) are JSON-serializable and returned
 * verbatim.
 *
 * `voteStore` is nullable because `memory.voting.enabled=false` leaves it
 * unconstructed; vote reads then throw `subsystem_disabled` per the SIDECAR
 * contract (§4.5).
 */
export interface MemoryServiceDeps {
  profileStore: Pick<ProfileStore, "list" | "history">;
  notesStore: Pick<
    MemoryStore,
    "recallHybridAsync" | "list" | "get" | "getConsolidatedInto"
  >;
  lessonStore: Pick<LessonStore, "listIndex" | "getById">;
  procedureStore: Pick<ProcedureStore, "listIndex" | "getById">;
  linkStore: Pick<LinkStore, "listAll" | "expand">;
  voteStore: Pick<VoteStore, "listEvents"> | null;
}

type MemoryScope = "all" | "project";

const DEFAULT_LIST_LIMIT = 200;
const DEFAULT_VOTE_LIMIT = 100;

export interface NotesRecallInput {
  query: string;
  k?: number;
  scope?: MemoryScope;
  workingDir?: string;
}

export interface NotesListInput {
  limit?: number;
  scope?: MemoryScope;
  workingDir?: string;
  excludeArchived?: boolean;
}

export interface LinksExpandInput {
  seedIds: number[];
  depth?: number;
  maxExpanded?: number;
}

/** A note with its consolidation pointer, returned by `memory.notes.get`. */
export interface NoteDetail {
  note: MemoryEntry | null;
  consolidatedInto: number | null;
}

export function listProfile(deps: MemoryServiceDeps): ProfileFact[] {
  return deps.profileStore.list();
}

export function profileHistory(
  deps: MemoryServiceDeps,
  key: string,
): ProfileFact[] {
  requireString(key, "key");
  return deps.profileStore.history(key);
}

export async function recallNotes(
  deps: MemoryServiceDeps,
  input: NotesRecallInput,
): Promise<MemoryEntry[]> {
  requireString(input.query, "query");
  return deps.notesStore.recallHybridAsync(input.query, {
    ...(input.k !== undefined ? { k: input.k } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.workingDir !== undefined
      ? { workingDir: input.workingDir }
      : {}),
  });
}

export function listNotes(
  deps: MemoryServiceDeps,
  input: NotesListInput = {},
): MemoryEntry[] {
  return deps.notesStore.list({
    limit: clampPositive(input.limit, DEFAULT_LIST_LIMIT),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.workingDir !== undefined
      ? { workingDir: input.workingDir }
      : {}),
    excludeArchived: input.excludeArchived ?? true,
  });
}

export function getNote(deps: MemoryServiceDeps, id: number): NoteDetail {
  requireId(id, "id");
  const note = deps.notesStore.get(id);
  return {
    note,
    consolidatedInto: note ? deps.notesStore.getConsolidatedInto(id) : null,
  };
}

export function listLessons(
  deps: MemoryServiceDeps,
  input: { limit?: number } = {},
): LessonIndexEntry[] {
  return deps.lessonStore.listIndex({
    limit: clampPositive(input.limit, DEFAULT_LIST_LIMIT),
  });
}

export function getLesson(deps: MemoryServiceDeps, id: number): Lesson | null {
  requireId(id, "id");
  return deps.lessonStore.getById(id);
}

export function listProcedures(
  deps: MemoryServiceDeps,
  input: { limit?: number } = {},
): ProcedureIndexEntry[] {
  return deps.procedureStore.listIndex({
    limit: clampPositive(input.limit, DEFAULT_LIST_LIMIT),
  });
}

export function getProcedure(
  deps: MemoryServiceDeps,
  id: number,
): Procedure | null {
  requireId(id, "id");
  return deps.procedureStore.getById(id);
}

export function listLinks(
  deps: MemoryServiceDeps,
  input: { limit?: number } = {},
): readonly LinkRow[] {
  return deps.linkStore.listAll({
    limit: clampPositive(input.limit, DEFAULT_LIST_LIMIT),
  });
}

export function expandLinks(
  deps: MemoryServiceDeps,
  input: LinksExpandInput,
): number[] {
  if (!Array.isArray(input.seedIds) || input.seedIds.length === 0) {
    throw new RuntimeApiError(
      "seedIds must be a non-empty array",
      "invalid_request",
      "seedIds",
    );
  }
  const opts: ExpandOptions = {};
  if (input.depth !== undefined) opts.depth = input.depth;
  if (input.maxExpanded !== undefined) opts.maxExpanded = input.maxExpanded;
  return deps.linkStore.expand(input.seedIds, opts);
}

export function listVotes(
  deps: MemoryServiceDeps,
  input: { limit?: number } = {},
): VoteEventRow[] {
  if (deps.voteStore === null) {
    throw new RuntimeApiError(
      "voting subsystem disabled",
      "subsystem_disabled",
    );
  }
  return deps.voteStore.listEvents({
    limit: clampPositive(input.limit, DEFAULT_VOTE_LIMIT),
  });
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeApiError(`${field} is required`, "invalid_request", field);
  }
}

function requireId(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new RuntimeApiError(
      `${field} must be a positive integer`,
      "invalid_request",
      field,
    );
  }
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
