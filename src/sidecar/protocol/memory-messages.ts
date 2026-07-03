/**
 * Request/response payload shapes for the read-only `memory.*` commands. See
 * SIDECAR.md §4.5. Native memory-fabric entity types are JSON-serializable
 * and are sent verbatim; the sidecar handlers project them through the
 * `memory-service` facade.
 */
import type { MemoryEntry, ProfileFact } from "../../memory/index.js";
import type { Lesson, LessonIndexEntry } from "../../memory/lessons/index.js";
import type {
  Procedure,
  ProcedureIndexEntry,
} from "../../memory/procedures/index.js";
import type { LinkRow } from "../../memory/links/index.js";
import type { VoteEventRow } from "../../memory/voting/index.js";

type MemoryScope = "all" | "project";

export interface MemoryProfileListPayload {
  [key: string]: never;
}
export interface MemoryProfileListResult {
  facts: ProfileFact[];
}

export interface MemoryProfileHistoryPayload {
  key: string;
}
export interface MemoryProfileHistoryResult {
  history: ProfileFact[];
}

export interface MemoryNotesRecallPayload {
  query: string;
  k?: number;
  scope?: MemoryScope;
  workingDir?: string;
}
export interface MemoryNotesRecallResult {
  notes: MemoryEntry[];
}

export interface MemoryNotesListPayload {
  limit?: number;
  scope?: MemoryScope;
  workingDir?: string;
  excludeArchived?: boolean;
}
export interface MemoryNotesListResult {
  notes: MemoryEntry[];
}

export interface MemoryNotesGetPayload {
  id: number;
}
export interface MemoryNotesGetResult {
  note: MemoryEntry | null;
  consolidatedInto: number | null;
}

export interface MemoryLessonsListPayload {
  limit?: number;
}
export interface MemoryLessonsListResult {
  lessons: LessonIndexEntry[];
}

export interface MemoryLessonsGetPayload {
  id: number;
}
export interface MemoryLessonsGetResult {
  lesson: Lesson | null;
}

export interface MemoryProceduresListPayload {
  limit?: number;
}
export interface MemoryProceduresListResult {
  procedures: ProcedureIndexEntry[];
}

export interface MemoryProceduresGetPayload {
  id: number;
}
export interface MemoryProceduresGetResult {
  procedure: Procedure | null;
}

export interface MemoryLinksListPayload {
  limit?: number;
}
export interface MemoryLinksListResult {
  links: readonly LinkRow[];
}

export interface MemoryLinksExpandPayload {
  seedIds: number[];
  depth?: number;
  maxExpanded?: number;
}
export interface MemoryLinksExpandResult {
  ids: number[];
}

export interface MemoryVotesListPayload {
  limit?: number;
}
export interface MemoryVotesListResult {
  events: VoteEventRow[];
}
