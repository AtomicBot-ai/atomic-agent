import { skillCuratorPaths } from "../curator/skill-curator-config.js";
import { listStarterSkillNames } from "../seed-starter-skills.js";
import { loadSkills } from "../skill-loader.js";
import { approvePendingDraft, PendingDraftError } from "./experience-review.js";
import { takenSkillNames } from "./learn-targets.js";
import {
  learnedJournalFile,
  LearnUndoError,
  readLearnedChanges,
  undoLearnedChange,
  type LearnedEntry,
} from "./learned-journal.js";
import { listPendingDrafts, PENDING_ID_PATTERN, removePendingDraft, type PendingDraft } from "./pending-drafts.js";

/**
 * `/learn` in the TUI and `atomic-agent skill learned` in the CLI
 * (ATO-67): the "Learned" list with its one-step undo, and the drafts
 * pending review with approve and discard. The words match OpenClaw's
 * `/learn undo <id>`.
 */

export type LearnCommand =
  | { kind: "list" }
  | { kind: "undo"; id: string }
  | { kind: "approve"; id: string }
  | { kind: "discard"; id: string }
  | { kind: "error"; message: string };

export const LEARN_USAGE = "usage: /learn | /learn undo <id> | /learn approve <id> | /learn discard <id>";

const ID_VERBS = new Set(["undo", "approve", "discard"]);

export function parseLearnCommand(args: string): LearnCommand {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || (words.length === 1 && words[0]!.toLowerCase() === "list")) return { kind: "list" };
  const verb = words[0]?.toLowerCase();
  if (words.length === 2 && verb !== undefined && ID_VERBS.has(verb) && PENDING_ID_PATTERN.test(words[1]!.toLowerCase())) {
    return { kind: verb as "undo" | "approve" | "discard", id: words[1]!.toLowerCase() };
  }
  return { kind: "error", message: LEARN_USAGE };
}

function stamp(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

function formatEntry(e: LearnedEntry): string {
  const verb = e.action === "create" ? "new skill" : "patched";
  const state = e.undoneAt !== undefined ? " (undone)" : "";
  return `  ${e.id}  ${stamp(e.at)}  ${verb} ${e.name}${state}${e.reason ? `: ${e.reason}` : ""}`;
}

function formatDraft(d: PendingDraft): string {
  const verb = d.kind === "create" ? "new skill" : "patch";
  const from = [d.origin, ...d.sources].filter((s): s is string => typeof s === "string" && s.length > 0);
  return `  ${d.id}  ${stamp(d.createdAt)}  ${verb} ${d.name} (Pending review)${d.reason ? `: ${d.reason}` : ""}${from.length > 0 ? ` [read: ${from.slice(0, 3).join(", ")}${from.length > 3 ? ", …" : ""}]` : ""}`;
}

/**
 * The list: drafts pending review first, then learned changes newest
 * first, at most `limit` rows. `prefix` is how the command is typed
 * (`/learn`, `atomic-agent skill learned`).
 */
export function formatLearnedList(
  entries: readonly LearnedEntry[],
  prefix: string,
  pending: readonly PendingDraft[] = [],
  limit = 30,
): string {
  if (entries.length === 0 && pending.length === 0) {
    return "Nothing learned yet. After a long task the agent may save what it learned as a skill; it shows up here.";
  }
  const lines: Array<string | null> = [];
  if (pending.length > 0) {
    lines.push(
      "Pending review (learned in a task that read outside content, or from a chat or API caller; not used until approved):",
      ...[...pending].reverse().map(formatDraft),
      `Approve one with ${prefix} approve <id>, or delete it with ${prefix} discard <id>.`,
    );
  }
  if (entries.length > 0) {
    const rows = [...entries].reverse().slice(0, limit);
    if (lines.length > 0) lines.push("");
    lines.push(
      "Learned skills (newest first):",
      ...rows.map(formatEntry),
      entries.length > rows.length ? `  … ${entries.length - rows.length} older` : null,
      `Undo one with ${prefix} undo <id>.`,
    );
  }
  return lines.filter((l): l is string => l !== null).join("\n");
}

export interface LearnCommandResult {
  text: string;
  /** True when a skill folder changed, so the caller refreshes the skill catalog. */
  skillsChanged: boolean;
  ok: boolean;
}

export interface LearnCommandDirs {
  stateDir: string;
  skillsDir: string;
  /**
   * Every skill name in use, for an approved new skill to be checked
   * against. The TUI passes its registry's view; by default the global
   * folder, the archive and the starter list are read.
   */
  takenNames?: () => Promise<ReadonlySet<string>>;
}

async function defaultTakenNames(dirs: LearnCommandDirs): Promise<ReadonlySet<string>> {
  const { skills } = await loadSkills({ globalDir: dirs.skillsDir, projectDir: null });
  return takenSkillNames({
    records: skills,
    starterNames: await listStarterSkillNames(),
    globalSkillsDir: dirs.skillsDir,
    archiveDir: skillCuratorPaths(dirs.stateDir).archiveDir,
  });
}

/** Run a parsed command against the state folder. Never throws. */
export async function runLearnCommand(
  command: LearnCommand,
  dirs: LearnCommandDirs,
  prefix = "/learn",
): Promise<LearnCommandResult> {
  const paths = skillCuratorPaths(dirs.stateDir);
  try {
    switch (command.kind) {
      case "error":
        return { text: command.message, skillsChanged: false, ok: false };
      case "list": {
        const [entries, pending] = await Promise.all([readLearnedChanges(learnedJournalFile(paths)), listPendingDrafts(dirs.stateDir)]);
        return { text: formatLearnedList(entries, prefix, pending), skillsChanged: false, ok: true };
      }
      case "undo": {
        const result = await undoLearnedChange({ skillsDir: dirs.skillsDir, paths }, command.id);
        const { name } = result.entry;
        const text =
          result.outcome === "removed"
            ? `Undid ${command.id}: removed the learned skill ${name} (kept in the archive; \`atomic-agent skill restore ${name}\` brings it back).`
            : result.outcome === "restored"
              ? `Undid ${command.id}: ${name} is back to the version before the patch${result.savedAs ? ` (the patched copy is saved as ${result.savedAs})` : ""}.`
              : `Undid ${command.id}: the learned skill ${name} was already gone.`;
        return { text, skillsChanged: result.outcome !== "already-gone", ok: true };
      }
      case "approve": {
        const takenNames = await (dirs.takenNames ?? (() => defaultTakenNames(dirs)))();
        const change = await approvePendingDraft({ stateDir: dirs.stateDir, skillsDir: dirs.skillsDir, takenNames }, command.id);
        const what = change.action === "create" ? `saved the new skill ${change.name}` : `patched ${change.name} (the previous version is saved)`;
        return { text: `Approved ${command.id}: ${what}. Undo it with ${prefix} undo ${change.id}.`, skillsChanged: true, ok: true };
      }
      case "discard": {
        const removed = await removePendingDraft(dirs.stateDir, command.id);
        if (!removed) return { text: `learn: no pending draft with id ${command.id} (see ${prefix})`, skillsChanged: false, ok: false };
        return { text: `Discarded draft ${command.id}.`, skillsChanged: false, ok: true };
      }
    }
  } catch (err) {
    const message = err instanceof LearnUndoError || err instanceof PendingDraftError || err instanceof Error ? err.message : String(err);
    return { text: `learn: ${message}`, skillsChanged: false, ok: false };
  }
}
