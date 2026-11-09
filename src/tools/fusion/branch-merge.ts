/**
 * Merging an isolated task back (branch isolation, ATO-946).
 *
 * After its wave, each task's workspace (`branch-workspace.ts`) is
 * merged into the working directory, in the caller's task order, one
 * file at a time against the snapshot every workspace started from:
 *
 *  - a file only this task changed is copied in (or removed);
 *  - a file the folder also changed since the snapshot (an earlier
 *    task of the wave, or the person) is merged with
 *    `git merge-file`; a clean text merge is written, anything else
 *    (overlapping edits, binary, an edit against a removal) is a
 *    conflict: the folder's file is left exactly as it is, both sides
 *    are saved under `.atomic-agent/fusion-merge/`, and the planner
 *    gets a merge task for them;
 *  - a declared input (`contract.inputs`, F51) the task removed or cut
 *    to under half its lines is refused at the door, whatever the
 *    worker's tools allowed inside its workspace (ATO-860, ATO-883).
 *
 * A task that failed, was cancelled, timed out or never got a slot is
 * not merged: its workspace, and what it wrote there, is thrown away.
 */
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { runCommand } from "../../sandbox/command-runner.js";
import { buildCommandEnv } from "../../sandbox/command-env.js";
import {
  BRANCH_MERGE_DIR,
  createBranchSet,
  touchedPaths,
  type BranchSet,
  type BranchWorkspace,
  type CreateBranchSetOptions,
} from "./branch-workspace.js";
import { resolveContractInputs } from "./contract-inputs.js";
import type { DelegateTask } from "./delegate-args.js";
import type { WorkerTaskResult, WorkerTaskStatus } from "./worker-result.js";

/** Statuses whose workspace is merged back; everything else is discarded. */
export const MERGED_STATUSES: ReadonlySet<WorkerTaskStatus> = new Set([
  "ok",
  "no_changes",
  "needs_orchestrator",
  "max_steps",
]);

/**
 * A three-way text merge of `current` with `other` over `base` (absolute
 * paths). `clean: true` with the merged text, or `clean: false`.
 */
export type MergeFile = (input: {
  current: string;
  base: string;
  other: string;
  cwd: string;
}) => Promise<{ clean: true; merged: string } | { clean: false }>;

/** `git merge-file -p`: exit 0 is a clean merge, anything else is not. */
export const gitMergeFile: MergeFile = async ({ current, base, other, cwd }) => {
  try {
    const result = await runCommand(
      "git",
      ["merge-file", "-p", "-L", "current", "-L", "base", "-L", "task", current, base, other],
      {
        cwd,
        env: { ...buildCommandEnv(process.env), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        timeoutMs: 60_000,
        maxOutputBytes: 64 * 1024 * 1024,
      },
    );
    if (result.exitCode !== 0 || result.timedOut || result.truncated) {
      return { clean: false };
    }
    return { clean: true, merged: result.stdout };
  } catch {
    return { clean: false };
  }
};

export interface RefusedPath {
  path: string;
  reason: string;
}

export interface BranchMergeOutcome {
  taskId: string;
  /** Paths written into (or removed from) the working directory. */
  applied: string[];
  /** Paths left as the folder has them, sides saved under `savedDir`. */
  conflicts: string[];
  /** Declared inputs the task would have removed or cut down. */
  refused: RefusedPath[];
  /** Paths that could neither be written nor saved: this task's change is gone. */
  lost?: string[];
  /** Where the conflicting sides were saved, relative to the working directory. */
  savedDir?: string;
}

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

function same(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

function lineCount(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (const byte of buf) if (byte === 0x0a) n += 1;
  return buf[buf.length - 1] === 0x0a ? n : n + 1;
}

/** Text a merge may touch: no NUL, and valid UTF-8 (merge output comes back as a string). */
function mergeableText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  return Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}

/**
 * Why writing `task` over the declared input `base` is refused, or
 * `undefined` when it is an edit in place.
 */
export function inputReplacement(
  base: Buffer | null,
  task: Buffer | null,
): string | undefined {
  if (base === null) return undefined;
  if (task === null) return "would remove the user's file";
  const before = lineCount(base);
  const after = lineCount(task);
  if (before >= 4 && after * 2 < before) {
    return `would replace the user's file (${before} → ${after} lines)`;
  }
  return undefined;
}

async function writeKeepingMode(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  const mode = (await lstat(from)).mode & 0o777;
  await chmod(to, mode).catch(() => undefined);
}

/**
 * Merge one workspace into `set.realDir`. `protectedPaths` are the
 * declared inputs relative to the working directory.
 */
export async function mergeBranch(
  set: Pick<BranchSet, "realDir" | "baseDir">,
  workspace: BranchWorkspace,
  protectedPaths: ReadonlySet<string>,
  mergeFile: MergeFile = gitMergeFile,
): Promise<BranchMergeOutcome> {
  const outcome: BranchMergeOutcome = {
    taskId: workspace.taskId,
    applied: [],
    conflicts: [],
    refused: [],
  };
  const savedRoot = join(BRANCH_MERGE_DIR, workspace.name);
  const save = async (rel: string, base: Buffer | null, task: Buffer | null): Promise<void> => {
    const at = join(set.realDir, savedRoot, rel);
    await mkdir(dirname(at), { recursive: true });
    if (task !== null) await writeBuffer(`${at}.task`, task);
    else await writeBuffer(`${at}.task-removed`, Buffer.alloc(0));
    if (base !== null) await writeBuffer(`${at}.base`, base);
    outcome.savedDir = savedRoot;
  };
  for (const rel of await touchedPaths(workspace)) {
    const taskPath = join(workspace.dir, rel);
    const basePath = join(set.baseDir, rel);
    const realPath = join(set.realDir, rel);
    const [task, base, current] = await Promise.all([
      readOrNull(taskPath),
      readOrNull(basePath),
      readOrNull(realPath),
    ]);
    // One path that cannot be written (a file where its folder should be,
    // a read-only target) must not cost the rest of the wave.
    try {
      // Touched, not changed: nothing to bring back.
      if (same(task, base)) continue;
      if (protectedPaths.has(rel)) {
        const reason = inputReplacement(base, task);
        if (reason !== undefined) {
          outcome.refused.push({ path: rel, reason });
          continue;
        }
      }
      // Already what the task wants (another task did the same).
      if (same(current, task)) continue;
      if (same(current, base)) {
        if (task === null) await rm(realPath, { force: true });
        else await writeKeepingMode(taskPath, realPath);
        outcome.applied.push(rel);
        continue;
      }
      // Both sides moved since the snapshot.
      if (
        task !== null &&
        base !== null &&
        current !== null &&
        mergeableText(task) &&
        mergeableText(base) &&
        mergeableText(current)
      ) {
        const merged = await mergeFile({
          current: realPath,
          base: basePath,
          other: taskPath,
          cwd: set.realDir,
        });
        if (merged.clean) {
          await writeBuffer(realPath, Buffer.from(merged.merged, "utf8"));
          outcome.applied.push(rel);
          continue;
        }
      }
      await save(rel, base, task);
      outcome.conflicts.push(rel);
    } catch {
      try {
        await save(rel, base, task);
        outcome.conflicts.push(rel);
      } catch {
        (outcome.lost ??= []).push(rel);
      }
    }
  }
  return outcome;
}

async function writeBuffer(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

/** A merge the planner should delegate: one per task that hit conflicts. */
export interface MergeTaskSuggestion {
  id: string;
  title: string;
  instructions: string;
  files: string[];
}

export function mergeTaskSuggestion(
  task: Pick<DelegateTask, "id" | "title">,
  outcome: BranchMergeOutcome,
): MergeTaskSuggestion | undefined {
  if (outcome.conflicts.length === 0 || outcome.savedDir === undefined) {
    return undefined;
  }
  const saved = outcome.savedDir.split(sep).join("/");
  const lines = outcome.conflicts.map((rel) => {
    const p = rel.split(sep).join("/");
    return `- ${p}: the folder's version is current; the task's is ${saved}/${p}.task (or ${saved}/${p}.task-removed when it removed the file), and the version both started from is ${saved}/${p}.base.`;
  });
  return {
    id: `merge-${task.id}`,
    title: `Merge ${task.title}`,
    instructions: [
      `Task ${task.id} ("${task.title}") changed files that also changed in the folder while it ran, so they were not merged automatically. For each file below, edit the folder's version in place so it keeps both changes' intent:`,
      ...lines,
      `Then delete ${saved}/.`,
    ].join("\n"),
    files: outcome.conflicts.map((rel) => rel.split(sep).join("/")),
  };
}

/** The row after its merge: notes for what landed, the error for what did not. */
export function applyMergeOutcome(
  row: WorkerTaskResult,
  outcome: BranchMergeOutcome,
): WorkerTaskResult {
  const notes = [...(row.notes ?? [])];
  if (outcome.applied.length > 0) {
    notes.push(
      `merged ${outcome.applied.length} file${outcome.applied.length === 1 ? "" : "s"} back from its own workspace`,
    );
  }
  const problems: string[] = [];
  if (outcome.conflicts.length > 0) {
    problems.push(
      `merge conflict in ${outcome.conflicts.join(", ")}: changed in the folder too while this task ran; the folder's version was kept and this task's is saved in ${outcome.savedDir ?? BRANCH_MERGE_DIR} (delegate merge-${row.id})`,
    );
  }
  for (const refused of outcome.refused) {
    problems.push(`merge refused for ${refused.path}: ${refused.reason}, a declared input`);
  }
  if (outcome.lost !== undefined && outcome.lost.length > 0) {
    problems.push(
      `could not write or save ${outcome.lost.join(", ")}: this task's change to ${outcome.lost.length === 1 ? "it" : "them"} is lost and has to be made again`,
    );
  }
  if (problems.length === 0) {
    return notes.length === (row.notes ?? []).length ? row : { ...row, notes };
  }
  return {
    ...row,
    status: row.status === "ok" || row.status === "no_changes" ? "needs_orchestrator" : row.status,
    error: [problems.join("; "), row.error].filter((e) => e !== undefined && e.length > 0).join("; "),
    ...(notes.length === 0 ? {} : { notes }),
  };
}

/**
 * Rewrite every mention of a root (the working directory, under any of
 * its spellings) to `to`, longest spelling first and each spot once.
 */
function rebaseText(text: string, roots: readonly string[], to: string): string {
  const mark = "\u0000workspace\u0000";
  let out = text;
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    if (root.length <= 1) continue;
    out = out.replace(
      new RegExp(`${escapeRegExp(root)}(?=[\\\\/]|$|[^\\w.-])`, "g"),
      mark,
    );
  }
  return out.split(mark).join(to);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The task as its worker sees it: paths into the working directory point into its workspace. */
export function rebaseTask(
  task: DelegateTask,
  roots: readonly string[],
  dir: string,
): DelegateTask {
  const note = `You work in a private copy of the project at ${dir}; what you change there is merged back into the project when you finish.`;
  return {
    ...task,
    instructions: `${note}\n\n${rebaseText(task.instructions, roots, dir)}`,
    ...(task.files === undefined
      ? {}
      : {
          files: task.files.map((f) =>
            isAbsolute(f) ? rebaseText(f, roots, dir) : f,
          ),
        }),
  };
}

/** The approved write scope with every directory inside the working directory moved into `dir`. */
export function rebaseScope(
  scope: readonly string[],
  roots: readonly string[],
  dir: string,
): string[] {
  const out: string[] = [];
  for (const entry of scope) {
    const root = [...roots]
      .sort((a, b) => b.length - a.length)
      .find((r) => entry === r || entry.startsWith(`${r}${sep}`));
    const mapped = root === undefined ? entry : join(dir, relative(root, entry));
    if (!out.includes(mapped)) out.push(mapped);
  }
  if (!out.includes(dir)) out.push(dir);
  return out;
}

export interface IsolatedWaveInput {
  /** The working directory the wave would otherwise write into. */
  realDir: string;
  tasks: readonly DelegateTask[];
  writeScope: readonly string[];
  /** The contract's declared inputs, as written. */
  inputs: readonly string[];
  run: (
    tasks: readonly DelegateTask[],
    taskWorkspace:
      | ((taskId: string) => { workingDir: string; writeScope: readonly string[] } | undefined)
      | undefined,
  ) => Promise<WorkerTaskResult[]>;
  options?: CreateBranchSetOptions & { mergeFile?: MergeFile };
}

export interface IsolatedWaveResult {
  results: WorkerTaskResult[];
  merges: MergeTaskSuggestion[];
  /** Set when the wave ran in place: why it could not be isolated. */
  inPlace?: string;
}

/**
 * Run one wave with a workspace per task and merge each back, in task
 * order. The workspaces are removed whatever happens, an abort and a
 * throw included. When no workspace can be made the wave runs in place,
 * as without isolation, and every row says so.
 */
export async function runIsolatedWave(
  input: IsolatedWaveInput,
): Promise<IsolatedWaveResult> {
  if (input.tasks.length === 0) {
    return { results: await input.run(input.tasks, undefined), merges: [] };
  }
  let set: BranchSet | null;
  let reason: string;
  try {
    set = await createBranchSet(
      input.realDir,
      input.tasks.map((t) => t.id),
      input.options,
    );
    reason = "the folder is too large to copy";
  } catch (err) {
    set = null;
    reason = err instanceof Error ? err.message : String(err);
  }
  if (set === null) {
    const results = await input.run(input.tasks, undefined);
    const note = `ran in the folder itself, not in a workspace of its own: ${reason}`;
    return {
      results: results.map((r) => ({ ...r, notes: [...(r.notes ?? []), note] })),
      merges: [],
      inPlace: reason,
    };
  }
  const branches = set;
  try {
    const roots = [...new Set([input.realDir, branches.realDir])];
    const rebased = input.tasks.map((task) => {
      const ws = branches.workspaces.get(task.id);
      return ws === undefined ? task : rebaseTask(task, roots, ws.dir);
    });
    const results = await input.run(rebased, (taskId) => {
      const ws = branches.workspaces.get(taskId);
      return ws === undefined
        ? undefined
        : { workingDir: ws.dir, writeScope: rebaseScope(input.writeScope, roots, ws.dir) };
    });
    const protectedPaths = new Set(
      resolveContractInputs(input.inputs, branches.realDir)
        .map((abs) => relative(branches.realDir, abs))
        .filter((rel) => rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)),
    );
    // Inputs named through a symlinked path (`/var` vs `/private/var`).
    for (const abs of resolveContractInputs(input.inputs, input.realDir)) {
      const rel = relative(input.realDir, abs);
      if (rel.length > 0 && !rel.startsWith("..")) protectedPaths.add(rel);
    }
    const merges: MergeTaskSuggestion[] = [];
    const out: WorkerTaskResult[] = [];
    for (const raw of results) {
      const ws = branches.workspaces.get(raw.id);
      if (ws === undefined) {
        out.push(raw);
        continue;
      }
      // The planner reads the folder's paths, not a workspace that is
      // about to be removed.
      const row: WorkerTaskResult = {
        ...raw,
        reply: rebaseText(raw.reply, [ws.dir], input.realDir),
        ...(raw.error === undefined
          ? {}
          : { error: rebaseText(raw.error, [ws.dir], input.realDir) }),
      };
      if (!MERGED_STATUSES.has(row.status)) {
        const dropped = (await touchedPaths(ws)).length;
        out.push(
          dropped === 0
            ? row
            : {
                ...row,
                notes: [
                  ...(row.notes ?? []),
                  `its changes to ${dropped} file${dropped === 1 ? "" : "s"} were discarded with its workspace (${row.status})`,
                ],
              },
        );
        continue;
      }
      const outcome = await mergeBranch(
        branches,
        ws,
        protectedPaths,
        input.options?.mergeFile,
      );
      out.push(applyMergeOutcome(row, outcome));
      const task = input.tasks.find((t) => t.id === row.id);
      const suggestion =
        task === undefined ? undefined : mergeTaskSuggestion(task, outcome);
      if (suggestion !== undefined) merges.push(suggestion);
    }
    return { results: out, merges };
  } finally {
    await branches.cleanup();
  }
}

/** The block under the status table that hands conflicts to the planner. */
export function renderMergeBlock(merges: readonly MergeTaskSuggestion[]): string {
  if (merges.length === 0) return "";
  const lines = merges.map(
    (m) => `- ${m.id}: ${m.title} (files: ${m.files.join(", ")})`,
  );
  return [
    "",
    "",
    `Merge needed: ${merges.length} task${merges.length === 1 ? "" : "s"} changed files that also changed in the folder while they ran. The folder's versions were kept. Delegate each merge below as a task (its instructions are in details.merges) or merge it yourself:`,
    ...lines,
  ].join("\n");
}
