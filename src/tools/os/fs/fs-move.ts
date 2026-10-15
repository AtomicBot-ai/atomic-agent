import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { ToolDefinition } from "../../tool-registry.js";
import { OS_FS_MOVE_CONTRACT, parseMoveArgs } from "./fs-move-contract.js";
import {
  NODE_MOVE_FS,
  isStrictlyInside,
  planMoves,
  sameEntry,
  type MoveFs,
  type PlannedMove,
} from "./fs-move-plan.js";
import { formatBytes, readPriorFile } from "./fs-replace-guard.js";
import { RESTORE_MAX_BYTES } from "./fs-restore-store.js";
import {
  requireFsApproval,
  type FsDangerousToolOptions,
} from "./fs-require-approval.js";
import { describeMoves, previewMoves } from "./fs-move-text.js";
import { okResult, partialResult, type Moved } from "./fs-move-result.js";

const NAME = OS_FS_MOVE_CONTRACT.name;

export interface OsFsMoveDeps {
  /** Filesystem calls; a test injects EXDEV here. Default `node:fs/promises`. */
  fs?: MoveFs;
}

/**
 * `os.fs.move` — move or rename files and folders without a shell
 * (#602: a small model spent 24 minutes on cmd.exe quoting to sort 72
 * files). Every move is checked before the operator is asked (source
 * present, no silent replacement, no folder into itself, no batch whose
 * result depends on its order), then the whole call is one approval,
 * then the moves run in order. Undo is another move: the result spells
 * out the reverse list. A replaced file's previous content goes to the
 * restore store, so `os.fs.restore` brings that back.
 */
export function buildOsFsMoveTool(
  options: FsDangerousToolOptions,
  deps: OsFsMoveDeps = {},
): ToolDefinition {
  const fs = deps.fs ?? NODE_MOVE_FS;
  return {
    name: NAME,
    description: OS_FS_MOVE_CONTRACT.description,
    readonly: OS_FS_MOVE_CONTRACT.readonly,
    async run(rawArgs, ctx) {
      const { moves: items, overwrite } = parseMoveArgs(rawArgs);
      const plan = await planMoves(items, {
        workingDir: ctx.workingDir,
        overwrite,
        fs,
      });
      const sources = plan.map((m) => m.source);
      const dests = plan.map((m) => m.dest);
      // A worker's declared inputs are never replaced (`fs-input-guard.ts`);
      // moving one away or onto one would lose it just the same.
      const declared = options.declaredInputs?.inputsOf(ctx.sessionId) ?? [];
      const touched = declared.find((input) =>
        plan.some(
          (m) =>
            m.source === input ||
            m.dest === input ||
            (m.folder && isStrictlyInside(m.source, input)),
        ),
      );
      if (touched !== undefined) {
        throw new Error(
          `os.fs.move: \`${touched}\` is an input of this task; it is not moved or replaced — copy what you need with os.fs.write instead`,
        );
      }
      await requireFsApproval(
        options,
        {
          // Both ends change: the source's folder loses an entry and the
          // destination gains one, so both are classified (weakest wins,
          // and the agent's own config on either end is `trust_config`).
          kind: "write",
          // Plus any trust-config file inside a moved folder: moving the
          // folder that holds `config.json` is a change to it, and the
          // classifier only matches the file's own path.
          paths: [
            ...sources,
            ...dests,
            ...(await trustPathsInside(plan, options.trustConfigPaths ?? [], fs)),
          ],
          sessionId: ctx.sessionId,
          tool: NAME,
          reason: describeMoves(plan),
          preview: previewMoves(plan),
          affectedResources: [...sources, ...dests],
          // A no to this move is a no to removing these paths another way.
          targetPaths: [
            ...sources,
            ...plan.filter((m) => m.replaces).map((m) => m.dest),
          ],
          workingDir: ctx.workingDir,
          trustConfigPaths: options.trustConfigPaths,
        },
        ctx.signal,
      );

      const done: Moved[] = [];
      const notes: string[] = [];
      for (const move of plan) {
        if (ctx.signal.aborted) {
          return partialResult(done, move, plan.length, "the turn was stopped", notes);
        }
        try {
          // Saved before the move, reported after it: a move that fails
          // has replaced nothing (the final step is always one rename).
          const note = move.replaces ? await saveReplaced(move, options, ctx) : null;
          done.push(await moveOne(move, fs));
          if (note !== null) notes.push(note);
        } catch (err) {
          return partialResult(done, move, plan.length, (err as Error).message, notes);
        }
      }
      return okResult(done, notes);
    },
  };
}

async function moveOne(move: PlannedMove, fs: MoveFs): Promise<Moved> {
  await fs.mkdir(dirname(move.dest), { recursive: true });
  // Re-checked right before the rename: a POSIX rename replaces an
  // existing file (or empty folder) without a word, and something may
  // have appeared there since the plan was made.
  await refuseIfOccupied(move, fs);
  try {
    await fs.rename(move.source, move.dest);
    return { move, method: "rename" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  // Another volume. Copy beside the destination under a name of our own,
  // then rename it into place: a failed copy only ever leaves (and
  // cleans up) our temporary, never the file being replaced, and the
  // original is removed only once the copy has fully landed.
  const temp = join(
    dirname(move.dest),
    `.${basename(move.dest)}.moving-${randomBytes(4).toString("hex")}`,
  );
  try {
    await fs.cp(move.source, temp, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    await refuseIfOccupied(move, fs);
    await fs.rename(temp, move.dest);
  } catch (err) {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  try {
    await fs.rm(move.source, { recursive: true });
  } catch (err) {
    return {
      move,
      method: "copy",
      sourceKept: `copied \`${move.from}\` to \`${move.dest}\`, but the original could not be removed (${(err as Error).message})`,
    };
  }
  return { move, method: "copy" };
}

/**
 * Throw when something other than the source now sits at a destination
 * the plan found free. The source itself showing up there is the
 * case-only rename the plan already allowed.
 */
async function refuseIfOccupied(move: PlannedMove, fs: MoveFs): Promise<void> {
  if (move.replaces) return;
  try {
    await fs.lstat(move.dest);
  } catch {
    return;
  }
  if (await sameEntry(fs, move.source, move.dest)) return;
  throw new Error(`\`${move.dest}\` appeared after the check; nothing was replaced`);
}

/**
 * The trust-config paths (`config.json`, `.env`) that lie inside a
 * folder this call moves away or moves into place, compared both as
 * spelled and on canonical paths so a symlinked state directory counts.
 */
async function trustPathsInside(
  plan: readonly PlannedMove[],
  trustPaths: readonly string[],
  fs: MoveFs,
): Promise<string[]> {
  if (trustPaths.length === 0) return [];
  const real = async (path: string) => {
    try {
      return await fs.realpath(path);
    } catch {
      return path;
    }
  };
  const roots: string[] = [];
  for (const move of plan) {
    if (!move.folder) continue;
    roots.push(move.source, move.dest, await real(move.source));
  }
  const hits: string[] = [];
  for (const trust of trustPaths) {
    const canonical = await real(trust);
    if (roots.some((root) => isStrictlyInside(root, trust) || isStrictlyInside(root, canonical))) {
      hits.push(trust);
    }
  }
  return hits;
}

/** Keep the file a move replaces, so `os.fs.restore` can bring it back. */
async function saveReplaced(
  move: PlannedMove,
  options: FsDangerousToolOptions,
  ctx: { workingDir: string; sessionId: string },
): Promise<string> {
  const prior = await readPriorFile(move.dest);
  const head = `replaced the existing file \`${move.dest}\``;
  if (options.restore === undefined || prior === null) {
    return `⚠ ${head}; no copy of its previous content was kept`;
  }
  if (prior.content === null) {
    return `⚠ ${head}; its previous content was too large to save (over ${formatBytes(RESTORE_MAX_BYTES)})`;
  }
  await options.restore.saveCopy(ctx.workingDir, move.dest, prior.content, {
    tool: NAME,
    lines: prior.lines ?? 0,
    sessionId: ctx.sessionId,
  });
  return `${head}; its previous content is saved — \`os.fs.restore ${JSON.stringify({ path: move.dest })}\` brings it back`;
}
