import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
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
import {
  listPendingDrafts,
  PENDING_ID_PATTERN,
  pendingDraftSkillFile,
  readPendingDraft,
  removePendingDraft,
  type PendingDraft,
} from "./pending-drafts.js";

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
  | { kind: "show"; id: string; json: boolean }
  | { kind: "error"; message: string };

export const LEARN_USAGE =
  "usage: /learn | /learn show <id> | /learn undo <id> | /learn approve <id> | /learn discard <id>";

const ID_VERBS = new Set(["undo", "approve", "discard"]);

export function parseLearnCommand(args: string): LearnCommand {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || (words.length === 1 && words[0]!.toLowerCase() === "list")) return { kind: "list" };
  const verb = words[0]?.toLowerCase();
  if (verb === "show" && (words.length === 2 || (words.length === 3 && words[2] === "--json")) && PENDING_ID_PATTERN.test(words[1]!.toLowerCase())) {
    return { kind: "show", id: words[1]!.toLowerCase(), json: words.length === 3 };
  }
  if (words.length === 2 && verb !== undefined && ID_VERBS.has(verb) && PENDING_ID_PATTERN.test(words[1]!.toLowerCase())) {
    return { kind: verb as "undo" | "approve" | "discard", id: words[1]!.toLowerCase() };
  }
  return { kind: "error", message: LEARN_USAGE };
}

/**
 * Text that came from the model or from a draft file is printed to a
 * terminal: control characters (ESC sequences, carriage returns, bells)
 * could repaint or hide what the person is approving, so they are
 * stripped. `oneLine` is for one-line fields (reason, sources, origin,
 * names, paths), `multiLine` keeps newlines and tabs for SKILL.md text
 * and diffs. C1 controls (\x80-\x9f, e.g. the one-byte CSI) go too.
 */
export function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/ {2,}/g, " ").trim();
}

export function multiLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function stamp(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

function formatEntry(e: LearnedEntry): string {
  const verb = e.action === "create" ? "new skill" : "patched";
  const state = e.undoneAt !== undefined ? " (undone)" : "";
  const reason = oneLine(e.reason);
  return `  ${e.id}  ${stamp(e.at)}  ${verb} ${oneLine(e.name)}${state}${reason ? `: ${reason}` : ""}`;
}

function draftFrom(d: PendingDraft): string[] {
  return [d.origin, ...d.sources].map((s) => (typeof s === "string" ? oneLine(s) : "")).filter((s) => s.length > 0);
}

function formatDraft(d: PendingDraft, stateDir?: string): string {
  const verb = d.kind === "create" ? "new skill" : "patch";
  const from = draftFrom(d);
  const reason = oneLine(d.reason);
  const row = `  ${d.id}  ${stamp(d.createdAt)}  ${verb} ${oneLine(d.name)} (Pending review)${reason ? `: ${reason}` : ""}${from.length > 0 ? ` [read: ${from.slice(0, 3).join(", ")}${from.length > 3 ? ", …" : ""}]` : ""}`;
  return stateDir === undefined ? row : `${row}\n          draft: ${oneLine(pendingDraftSkillFile(stateDir, d.id))}`;
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
  options: { limit?: number; stateDir?: string } = {},
): string {
  const limit = options.limit ?? 30;
  if (entries.length === 0 && pending.length === 0) {
    return "Nothing learned yet. After a long task the agent may save what it learned as a skill; it shows up here.";
  }
  const lines: Array<string | null> = [];
  if (pending.length > 0) {
    lines.push(
      "Pending review (learned in a task that read outside content, or from a chat or API caller; not used until approved):",
      ...[...pending].reverse().map((d) => formatDraft(d, options.stateDir)),
      `Read one in full with ${prefix} show <id>, then approve it with ${prefix} approve <id> or delete it with ${prefix} discard <id>.`,
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
        return { text: formatLearnedList(entries, prefix, pending, { stateDir: dirs.stateDir }), skillsChanged: false, ok: true };
      }
      case "show": {
        const view = await showPendingDraft(dirs, command.id);
        if (view === null) return { text: `learn: no pending draft with id ${command.id} (see ${prefix})`, skillsChanged: false, ok: false };
        return { text: command.json ? JSON.stringify(view, null, 2) : formatDraftView(view, prefix), skillsChanged: false, ok: true };
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

/**
 * What `show <id>` prints, and the exact `skill learned show <id> --json`
 * shape the desktop reads (keep the field names). `createdAt` is epoch
 * ms. For a patch, `currentSkillMd` is the live SKILL.md and `diff` a
 * unified diff from it to the draft; both are null for a new skill or
 * when the live skill is gone. Every string is already cleaned of
 * control characters.
 */
export interface PendingDraftView {
  id: string;
  kind: "create" | "patch";
  skill: string;
  path: string;
  origin: string | null;
  sources: string[];
  reason: string;
  createdAt: number;
  skillMd: string;
  currentSkillMd: string | null;
  diff: string | null;
}

/** A unified diff from the live SKILL.md to the draft, with `---`/`+++` headers only. */
export function skillMdDiff(name: string, current: string, draft: string): string {
  return createTwoFilesPatch(`a/${name}/SKILL.md`, `b/${name}/SKILL.md`, current, draft, undefined, undefined, {
    context: 3,
    headerOptions: FILE_HEADERS_ONLY,
  });
}

export async function showPendingDraft(
  dirs: Pick<LearnCommandDirs, "stateDir" | "skillsDir">,
  id: string,
): Promise<PendingDraftView | null> {
  const found = await readPendingDraft(dirs.stateDir, id);
  if (found === null) return null;
  const { draft, content } = found;
  let current: string | null = null;
  if (draft.kind === "patch") {
    try {
      current = await readFile(join(dirs.skillsDir, draft.name, "SKILL.md"), "utf8");
    } catch {
      current = null;
    }
  }
  return {
    id: draft.id,
    kind: draft.kind,
    skill: oneLine(draft.name),
    path: oneLine(pendingDraftSkillFile(dirs.stateDir, draft.id)),
    origin: draft.origin !== undefined ? oneLine(draft.origin) : null,
    sources: draft.sources.map(oneLine).filter((s) => s.length > 0),
    reason: oneLine(draft.reason),
    createdAt: draft.createdAt,
    skillMd: multiLine(content),
    currentSkillMd: current === null ? null : multiLine(current),
    diff: current === null ? null : multiLine(skillMdDiff(draft.name, current, content)),
  };
}

function formatDraftView(v: PendingDraftView, prefix: string): string {
  const lines = [
    `Draft ${v.id} (Pending review, not used until you approve it)`,
    `  kind:    ${v.kind === "create" ? "new skill" : "patch of an existing skill"}`,
    `  skill:   ${v.skill}`,
    `  path:    ${v.path}`,
    `  origin:  ${v.origin ?? "-"}`,
    `  sources: ${v.sources.length > 0 ? v.sources.join(", ") : "-"}`,
    `  reason:  ${v.reason || "-"}`,
    `  created: ${stamp(v.createdAt)}`,
  ];
  if (v.kind === "patch") {
    lines.push("");
    if (v.diff === null) {
      lines.push(`${v.skill} is no longer installed, so there is nothing to compare with; approving it will fail, discard it.`);
    } else {
      lines.push(`Changes to the live ${v.skill}/SKILL.md:`, v.diff.replace(/\n$/, ""));
    }
  }
  lines.push("", "Draft SKILL.md in full:", "-----", v.skillMd.replace(/\n$/, ""), "-----");
  lines.push(`Approve it with ${prefix} approve ${v.id}, or delete it with ${prefix} discard ${v.id}.`);
  return lines.join("\n");
}
