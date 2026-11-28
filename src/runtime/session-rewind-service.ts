import type { ConversationTurn } from "../session/conversation-turn.js";
import { keepBranch } from "../session/session-message-branches.js";
import { planRewind, type RewindRefusal } from "../session/session-rewind.js";
import type { SessionState } from "../session/session-state.js";
import {
  applyFileRestore,
  planFileRestore,
  uncoveredToolCalls,
  type FileNotRestorable,
  type FileRestoreResult,
} from "../tools/os/fs/fs-checkpoint-restore.js";
import { FileCheckpointStore, fileCheckpointsRoot } from "../tools/os/fs/fs-checkpoint-store.js";
import type { AgentRuntime } from "./runtime-contract.js";

/**
 * Taking a chat back to one of its questions, with its files (ATO-1056,
 * ATO-2467). One implementation for every frontend: the HTTP rewind
 * routes and the terminal's `/rewind` both call it, so "Chat and files",
 * "Chat only" and "Files only" mean the same thing everywhere.
 *
 * Which rows are points and which cuts are refused is
 * `session/session-rewind.ts`; which files change and how they are put
 * back is `tools/os/fs/fs-checkpoint-restore.ts`. This module orders
 * them: files first, then the chat, then the copies of the turns that
 * are gone. Only the agent's own file tools are covered; the preview
 * names the shell, git, archive, subagent and Fusion calls whose changes
 * stay.
 */

/** What a rewind takes back: both, the conversation only, or the files only. */
export type RewindScope = "all" | "conversation" | "files";

export interface RewindPreview {
  turnIndex: number;
  /** The question at that point, as stored. */
  text: string;
  /** Questions and replies a cut would remove. */
  removed: { questions: number; replies: number };
  /** Files that will really change (a copy matching the disk is left out). */
  files: { path: string; action: "restore" | "delete" }[];
  /** Files changed without a saved copy: they stay as they are. */
  notRestorable: FileNotRestorable[];
  /** Some changes from that point on are no longer kept. */
  incomplete: boolean;
  /** Calls whose file changes no checkpoint covers. */
  uncovered: { tool: string; count: number }[];
}

export interface RewindOutcome extends FileRestoreResult {
  text: string;
  /** The cut session, already saved; null when only the files moved. */
  state: SessionState | null;
  notRestorable: FileNotRestorable[];
  incomplete: boolean;
}

export type RewindResult<T> = { ok: true; value: T } | { ok: false; code: RewindRefusal };

export interface SessionRewindDeps {
  sessionStore: Pick<AgentRuntime["sessionStore"], "save" | "clearTurnProgress">;
  cancelSessionCompaction(sessionId: string): boolean;
  checkpoints: Pick<FileCheckpointStore, "since" | "readCopy" | "dropSince">;
}

/** The parts of the runtime a rewind needs. */
export type SessionRewindRuntime = Pick<AgentRuntime, "sessionStore" | "config"> & {
  cancelSessionCompaction?: AgentRuntime["cancelSessionCompaction"];
};

/**
 * Deps read from the runtime at call time (so a frontend sees the
 * runtime it holds now), with the checkpoints the file tools write.
 */
export function sessionRewindDeps(runtime: SessionRewindRuntime): SessionRewindDeps {
  return {
    sessionStore: runtime.sessionStore,
    cancelSessionCompaction: (id) => runtime.cancelSessionCompaction?.(id) ?? false,
    checkpoints: new FileCheckpointStore(fileCheckpointsRoot(runtime.config.paths.stateDir)),
  };
}

/** What a rewind to the question at `turnIndex` would do. Changes nothing. */
export async function previewSessionRewind(
  deps: Pick<SessionRewindDeps, "checkpoints">,
  session: SessionState,
  turnIndex: number,
  expectText?: string,
): Promise<RewindResult<RewindPreview>> {
  const plan = planRewind(session, turnIndex, expectText);
  if (!plan.ok) return plan;
  const at = session.turns[turnIndex]!.at;
  const files = await planFileRestore(deps.checkpoints, session.id, at);
  const removed = session.turns.slice(turnIndex);
  return {
    ok: true,
    value: {
      turnIndex,
      text: plan.text,
      removed: removedCounts(removed),
      files: files.items.map((item) => ({ path: item.path, action: item.action })),
      notRestorable: files.notRestorable,
      incomplete: files.incomplete,
      uncovered: uncoveredToolCalls(removed),
    },
  };
}

/**
 * Do it. `files` puts the files back and leaves the chat and its saved
 * copies as they are (a later rewind still finds them). `conversation`
 * cuts the chat only. `all` puts the files back first, then cuts the
 * chat. Each file is tried on its own: one that cannot be written lands
 * in `failed` and the rest still go back. `keepBranch` (an Edit,
 * ATO-2470) keeps the cut rows as a version of the message; it means
 * nothing for `files`, which cuts no rows.
 */
export async function applySessionRewind(
  deps: SessionRewindDeps,
  session: SessionState,
  turnIndex: number,
  scope: RewindScope,
  expectText?: string,
  options: { keepBranch?: boolean } = {},
): Promise<RewindResult<RewindOutcome>> {
  const plan = planRewind(session, turnIndex, expectText);
  if (!plan.ok) return plan;
  const at = session.turns[turnIndex]!.at;
  const files = await planFileRestore(deps.checkpoints, session.id, at);
  if (scope === "files") {
    const done = await applyFileRestore(deps.checkpoints, session.id, files);
    return {
      ok: true,
      value: { text: plan.text, state: null, ...done, notRestorable: files.notRestorable, incomplete: files.incomplete },
    };
  }
  // A compaction started on this chat would summarise the rows removed.
  deps.cancelSessionCompaction(session.id);
  const restoreFiles = scope === "all";
  const done = restoreFiles
    ? await applyFileRestore(deps.checkpoints, session.id, files)
    : { restored: [], deleted: [], failed: [] };
  const saved = options.keepBranch === true ? keepBranch(session, turnIndex, plan.state) : plan.state;
  deps.sessionStore.save(saved);
  deps.sessionStore.clearTurnProgress(session.id);
  // The turns those copies belong to are gone.
  await deps.checkpoints.dropSince(session.id, at);
  return {
    ok: true,
    value: {
      text: plan.text,
      state: saved,
      ...done,
      notRestorable: restoreFiles ? files.notRestorable : [],
      incomplete: restoreFiles && files.incomplete,
    },
  };
}

function removedCounts(rows: readonly ConversationTurn[]): { questions: number; replies: number } {
  let questions = 0;
  let replies = 0;
  for (const row of rows) {
    if (row.kind === "user" && row.steered !== true) questions += 1;
    if (row.kind === "assistant_reply" && row.progressNote !== true && row.stopped !== true) replies += 1;
  }
  return { questions, replies };
}
