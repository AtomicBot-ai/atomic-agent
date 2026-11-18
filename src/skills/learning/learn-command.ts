import { skillCuratorPaths } from "../curator/skill-curator-config.js";
import {
  learnedJournalFile,
  LearnUndoError,
  readLearnedChanges,
  undoLearnedChange,
  type LearnedEntry,
} from "./learned-journal.js";

/**
 * `/learn` in the TUI and `atomic-agent skill learned` in the CLI
 * (ATO-67): the "Learned" list and its one-step undo. The words match
 * OpenClaw's `/learn undo <id>`.
 */

export type LearnCommand =
  | { kind: "list" }
  | { kind: "undo"; id: string }
  | { kind: "error"; message: string };

export const LEARN_USAGE = "usage: /learn | /learn undo <id>";

export function parseLearnCommand(args: string): LearnCommand {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || (words.length === 1 && words[0]!.toLowerCase() === "list")) return { kind: "list" };
  if (words.length === 2 && words[0]!.toLowerCase() === "undo" && /^[0-9a-f]{4,16}$/i.test(words[1]!)) {
    return { kind: "undo", id: words[1]!.toLowerCase() };
  }
  return { kind: "error", message: LEARN_USAGE };
}

function formatEntry(e: LearnedEntry): string {
  const when = new Date(e.at).toISOString().slice(0, 16).replace("T", " ");
  const verb = e.action === "create" ? "new skill" : "patched";
  const state = e.undoneAt !== undefined ? " (undone)" : "";
  return `  ${e.id}  ${when}  ${verb} ${e.name}${state}${e.reason ? `: ${e.reason}` : ""}`;
}

/** The list, newest first; at most `limit` rows. */
export function formatLearnedList(entries: readonly LearnedEntry[], undoHint: string, limit = 30): string {
  if (entries.length === 0) {
    return "Nothing learned yet. After a long task the agent may save what it learned as a skill; it shows up here.";
  }
  const rows = [...entries].reverse().slice(0, limit);
  return [
    "Learned skills (newest first):",
    ...rows.map(formatEntry),
    entries.length > rows.length ? `  … ${entries.length - rows.length} older` : null,
    `Undo one with ${undoHint}.`,
  ].filter((l): l is string => l !== null).join("\n");
}

export interface LearnCommandResult {
  text: string;
  /** True when a skill folder changed, so the caller refreshes the skill catalog. */
  skillsChanged: boolean;
  ok: boolean;
}

/** Run a parsed command against the state folder. Never throws. */
export async function runLearnCommand(
  command: LearnCommand,
  dirs: { stateDir: string; skillsDir: string },
  undoHint = "/learn undo <id>",
): Promise<LearnCommandResult> {
  const paths = skillCuratorPaths(dirs.stateDir);
  try {
    switch (command.kind) {
      case "error":
        return { text: command.message, skillsChanged: false, ok: false };
      case "list":
        return { text: formatLearnedList(await readLearnedChanges(learnedJournalFile(paths)), undoHint), skillsChanged: false, ok: true };
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
    }
  } catch (err) {
    const message = err instanceof LearnUndoError || err instanceof Error ? err.message : String(err);
    return { text: `learn: ${message}`, skillsChanged: false, ok: false };
  }
}
