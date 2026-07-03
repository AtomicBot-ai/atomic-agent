import {
  expandLinks,
  getLesson,
  getNote,
  getProcedure,
  listLessons,
  listLinks,
  listNotes,
  listProcedures,
  listProfile,
  listVotes,
  profileHistory,
  recallNotes,
  type MemoryServiceDeps,
} from "../../runtime-api/index.js";
import type {
  MemoryLessonsGetPayload,
  MemoryLessonsGetResult,
  MemoryLessonsListPayload,
  MemoryLessonsListResult,
  MemoryLinksExpandPayload,
  MemoryLinksExpandResult,
  MemoryLinksListPayload,
  MemoryLinksListResult,
  MemoryNotesGetPayload,
  MemoryNotesGetResult,
  MemoryNotesListPayload,
  MemoryNotesListResult,
  MemoryNotesRecallPayload,
  MemoryNotesRecallResult,
  MemoryProceduresGetPayload,
  MemoryProceduresGetResult,
  MemoryProceduresListPayload,
  MemoryProceduresListResult,
  MemoryProfileHistoryPayload,
  MemoryProfileHistoryResult,
  MemoryProfileListPayload,
  MemoryProfileListResult,
  MemoryVotesListPayload,
  MemoryVotesListResult,
} from "../protocol/index.js";
import type { SidecarHandlerContext } from "./handler-context.js";

/**
 * `memory.*` — read-only inspection of the six memory-fabric channels
 * (profile / notes / lessons / procedures / links / votes). Every handler
 * is pure inspection over the shared `memory-service` facade; no writes.
 */
export function registerMemoryHandlers(ctx: SidecarHandlerContext): void {
  const { router, runtime } = ctx;

  const deps: MemoryServiceDeps = {
    profileStore: runtime.profileStore,
    notesStore: runtime.notesStore,
    lessonStore: runtime.lessonStore,
    procedureStore: runtime.procedureStore,
    linkStore: runtime.linkStore,
    voteStore: runtime.voteStore,
  };

  router.register<MemoryProfileListPayload, MemoryProfileListResult>(
    "memory.profile.list",
    () => ({ facts: listProfile(deps) }),
  );

  router.register<MemoryProfileHistoryPayload, MemoryProfileHistoryResult>(
    "memory.profile.history",
    (request) => ({ history: profileHistory(deps, request.payload.key) }),
  );

  router.register<MemoryNotesRecallPayload, MemoryNotesRecallResult>(
    "memory.notes.recall",
    async (request) => ({ notes: await recallNotes(deps, request.payload) }),
  );

  router.register<MemoryNotesListPayload, MemoryNotesListResult>(
    "memory.notes.list",
    (request) => ({ notes: listNotes(deps, request.payload) }),
  );

  router.register<MemoryNotesGetPayload, MemoryNotesGetResult>(
    "memory.notes.get",
    (request) => getNote(deps, request.payload.id),
  );

  router.register<MemoryLessonsListPayload, MemoryLessonsListResult>(
    "memory.lessons.list",
    (request) => ({ lessons: listLessons(deps, request.payload) }),
  );

  router.register<MemoryLessonsGetPayload, MemoryLessonsGetResult>(
    "memory.lessons.get",
    (request) => ({ lesson: getLesson(deps, request.payload.id) }),
  );

  router.register<MemoryProceduresListPayload, MemoryProceduresListResult>(
    "memory.procedures.list",
    (request) => ({ procedures: listProcedures(deps, request.payload) }),
  );

  router.register<MemoryProceduresGetPayload, MemoryProceduresGetResult>(
    "memory.procedures.get",
    (request) => ({ procedure: getProcedure(deps, request.payload.id) }),
  );

  router.register<MemoryLinksListPayload, MemoryLinksListResult>(
    "memory.links.list",
    (request) => ({ links: listLinks(deps, request.payload) }),
  );

  router.register<MemoryLinksExpandPayload, MemoryLinksExpandResult>(
    "memory.links.expand",
    (request) => ({ ids: expandLinks(deps, request.payload) }),
  );

  router.register<MemoryVotesListPayload, MemoryVotesListResult>(
    "memory.votes.list",
    (request) => ({ events: listVotes(deps, request.payload) }),
  );
}
