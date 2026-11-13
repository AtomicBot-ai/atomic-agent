import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parsePatch, type StructuredPatch } from "diff";
import { resolveUserPath } from "../expand-home.js";
import { parseMoveArgs } from "./fs-move-contract.js";
import { pickTargetPath } from "./fs-patch-preview.js";
import type { FileCheckpointStore } from "./fs-checkpoint-store.js";

/**
 * Which files a file-tool call is about to change (ATO-1056), read from
 * its arguments the way the tool reads them, so their content can be
 * saved first (`fs-checkpoint-store.ts`).
 *
 * Only the agent's own file tools are covered. A shell command, an
 * archive extraction, a git command or a Fusion worker (its own session)
 * changes files this cannot see; a rollback says so instead of
 * pretending (`uncoveredToolCalls` in `fs-checkpoint-restore.ts`).
 *
 * An argument the tool will refuse yields no path or a path that does
 * not change: the copy is then of a file that stays as it is, and a
 * rollback, which compares with the disk, leaves it alone.
 */

/** The file tools whose targets are saved before they run. */
export const CHECKPOINTED_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.write",
  "os.fs.edit",
  "os.fs.patch",
  "os.fs.move",
  "os.fs.trash",
  "os.fs.restore",
  // Office files (ATO-541, ATO-537): listed by name before those tools
  // land; an unknown name is never dispatched, so the entry is inert.
  "os.fs.docx",
  "os.fs.xlsx",
  "os.fs.write_pptx",
]);

export interface CheckpointTargetDeps {
  isDirectory?: (absolute: string) => boolean;
  readText?: (absolute: string) => string;
}

export function checkpointTargets(
  tool: string,
  args: Record<string, unknown>,
  workingDir: string,
  deps: CheckpointTargetDeps = {},
): string[] {
  const isDirectory = deps.isDirectory ?? isDirectoryOnDisk;
  const readText = deps.readText ?? ((path: string) => readFileSync(path, "utf8"));
  const at = (path: unknown): string | null => {
    if (typeof path !== "string" || path.length === 0) return null;
    try {
      return resolveUserPath(path, workingDir);
    } catch {
      return null;
    }
  };
  const out: string[] = [];
  const add = (path: string | null): void => {
    if (path !== null && !out.includes(path)) out.push(path);
  };
  switch (tool) {
    case "os.fs.write":
    case "os.fs.edit":
    case "os.fs.restore":
      add(at(args.path));
      break;
    case "os.fs.write_pptx":
      add(at(args.path));
      break;
    case "os.fs.docx":
      // Every op writes: create, append, replace.
      if (args.op === "create" || args.op === "append" || args.op === "replace") add(at(args.path));
      break;
    case "os.fs.xlsx":
      // op read only shows a range.
      if (args.op === "create" || args.op === "write") add(at(args.path));
      break;
    case "os.fs.trash":
      if (Array.isArray(args.paths)) for (const path of args.paths) add(at(path));
      break;
    case "os.fs.move": {
      let moves: { from: string; to: string }[];
      try {
        moves = parseMoveArgs(args).moves;
      } catch {
        break;
      }
      for (const move of moves) {
        const from = at(move.from);
        const to = at(move.to);
        add(from);
        if (to === null) continue;
        // "Inside it": a trailing separator or an existing folder (fs-move.ts).
        const intoFolder = /[\\/]$/.test(move.to) || isDirectory(to);
        add(intoFolder && from !== null ? join(to, basename(from)) : to);
      }
      break;
    }
    case "os.fs.patch":
      for (const path of patchTargets(args, workingDir, at, readText)) add(path);
      break;
    default:
      break;
  }
  return out;
}

function patchTargets(
  args: Record<string, unknown>,
  workingDir: string,
  at: (path: unknown) => string | null,
  readText: (absolute: string) => string,
): string[] {
  // A dry run (the default) writes nothing.
  if (args.apply !== true) return [];
  let source: string;
  if (typeof args.patch === "string" && args.patch.length > 0) {
    source = args.patch;
  } else {
    const file = at(args.patchPath);
    if (file === null) return [];
    try {
      source = readText(file);
    } catch {
      return [];
    }
  }
  let files: StructuredPatch[];
  try {
    files = parsePatch(source) as StructuredPatch[];
  } catch {
    return [];
  }
  const rootDir = at(args.rootDir) ?? workingDir;
  const strip =
    typeof args.stripComponents === "number" && Number.isFinite(args.stripComponents) && args.stripComponents >= 0
      ? Math.floor(args.stripComponents)
      : 1;
  return files.map((file) => {
    const rel = pickTargetPath(file, strip);
    return isAbsolute(rel) ? rel : resolve(rootDir, rel);
  });
}

function isDirectoryOnDisk(absolute: string): boolean {
  try {
    return statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The registry's pre-dispatch hook (`ToolRegistryOptions.beforeInvoke`):
 * save the targets of a covered file tool before it runs. Never throws.
 */
export function checkpointBeforeInvoke(
  store: Pick<FileCheckpointStore, "capture">,
): (tool: string, args: Record<string, unknown>, ctx: { sessionId: string; workingDir: string }) => Promise<void> {
  return async (tool, args, ctx) => {
    if (!CHECKPOINTED_TOOLS.has(tool)) return;
    let paths: string[];
    try {
      paths = checkpointTargets(tool, args, ctx.workingDir);
    } catch {
      return;
    }
    for (const path of paths) await store.capture(ctx.sessionId, path, tool);
  };
}
