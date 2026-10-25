import { stat } from "node:fs/promises";
import { homedir } from "node:os";

import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import { isFusionWorkerSessionId } from "../../../session/fusion-worker-session.js";
import {
  isScratchPath,
  isUnderAny,
  sessionReadRoots,
} from "../../read-scope/read-scope.js";
import type { ToolContext } from "../../tool-registry.js";
import {
  candidateName,
  defaultCandidateRoots,
  findPathCandidates,
  type CandidateRoot,
  type PathCandidate,
} from "./path-candidates.js";

/**
 * The answer a read-class tool gives for a path that does not exist: a
 * tool result (not a throw, so the compressor's short error cap cannot
 * cut the instruction off) naming where something with that name
 * actually is (ATO-413). `details` carry the error code and the path for
 * the log; nothing here ever carries file contents.
 */

/** Candidates shown in one result; the rest are counted, not listed. */
const MAX_SHOWN = 5;

export const MISSING_PATH_CODE = "ENOENT";

type MissingPathContext = Pick<
  ToolContext,
  "workingDir" | "readRoots" | "sessionId"
>;

/** A missing path, already answered. */
export interface MissingPath {
  missing: CompressedToolResult;
}

/** Whether `err` is Node's "no such file or directory". */
export function isMissingPathError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === MISSING_PATH_CODE
  );
}

/**
 * Run `op` on `absolute`; when it fails because the path does not exist,
 * answer with `missingPathResult` instead. Every other failure is
 * rethrown unchanged.
 */
export async function orMissing<T>(
  tool: string,
  absolute: string,
  ctx: MissingPathContext,
  op: () => Promise<T>,
): Promise<T | MissingPath> {
  try {
    return await op();
  } catch (err) {
    if (!isMissingPathError(err)) throw err;
    return { missing: await missingPathResult(tool, absolute, ctx) };
  }
}

/**
 * For a tool that tolerates an unreadable root (glob walks on and finds
 * nothing): the missing-path answer when `absolute` does not exist,
 * otherwise `null`, leaving every other outcome to the tool as before.
 */
export async function missingRoot(
  tool: string,
  absolute: string,
  ctx: MissingPathContext,
): Promise<CompressedToolResult | null> {
  const missing = await stat(absolute).then(
    () => false,
    (err: unknown) => isMissingPathError(err),
  );
  return missing ? missingPathResult(tool, absolute, ctx) : null;
}

export async function missingPathResult(
  tool: string,
  absolute: string,
  ctx: MissingPathContext,
  roots: readonly CandidateRoot[] = searchRoots(ctx),
): Promise<CompressedToolResult> {
  const candidates = await findPathCandidates(absolute, roots);
  const output = missingPathMessage(tool, absolute, candidates, (path) =>
    inScope(path, ctx),
  );
  return compressToolResult(
    {
      tool,
      status: "error",
      output,
      details: {
        path: absolute,
        errorCode: MISSING_PATH_CODE,
        candidates: candidates.map((c) => c.path),
      },
    },
    { maxSummaryLength: Math.max(1000, output.length + 50), maxTailLines: 20 },
  );
}

/**
 * A fusion worker's world is its task's folders and it has nobody to
 * ask, so it searches only its working directory; a session searches the
 * usual places a user keeps things.
 */
function searchRoots(ctx: MissingPathContext): CandidateRoot[] {
  const all = defaultCandidateRoots(ctx.workingDir, homedir());
  return isFusionWorkerSessionId(ctx.sessionId) ? all.slice(0, 1) : all;
}

/** Inside the working folder, a folder the user named, or scratch space. */
function inScope(path: string, ctx: MissingPathContext): boolean {
  return isUnderAny(path, sessionReadRoots(ctx)) || isScratchPath(path);
}

/**
 * Short, next-move wording, the instruction before any list so a clipped
 * result still carries it. One candidate: use it. Several: ask the user
 * which one, do not guess. None: ask the user where it is, do not retry
 * the same path. A candidate outside the working folder is marked so,
 * with the way to reach it: the user opens that folder as the working
 * folder.
 */
export function missingPathMessage(
  tool: string,
  absolute: string,
  candidates: readonly PathCandidate[],
  isInScope: (path: string) => boolean,
): string {
  const head = `${tool}: ${absolute} does not exist (ENOENT: no such file or directory).`;
  const name = candidateName(absolute) ?? absolute;
  if (candidates.length === 0) {
    return (
      `${head} Nothing named "${name}" was found in the working folder, ` +
      "Desktop, Documents, Downloads or the home folder. " +
      "Ask the user where it is; do not retry the same path."
    );
  }
  const shown = candidates.slice(0, MAX_SHOWN);
  const outsideNote = shown.some((c) => !isInScope(c.path))
    ? " For a path outside the working folder, ask the user to open " +
      "that folder as the working folder."
    : "";
  if (candidates.length === 1) {
    const only = shown[0]!;
    const use = isInScope(only.path)
      ? ` Use that path${nextMove(tool, only)}.`
      : "";
    return `${head} Found "${name}" at ${describe(only, isInScope)}.${use}${outsideNote}`;
  }
  const list = shown.map((c) => `- ${describe(c, isInScope)}`);
  if (candidates.length > MAX_SHOWN) list.push("- … and more");
  return (
    `${head} Found several items named "${name}". ` +
    `Ask the user which one they mean; do not guess.${outsideNote}\n` +
    list.join("\n")
  );
}

function describe(
  candidate: PathCandidate,
  isInScope: (path: string) => boolean,
): string {
  const notes: string[] = [];
  if (candidate.kind !== "other") notes.push(candidate.kind);
  if (!isInScope(candidate.path)) notes.push("outside the working folder");
  return notes.length === 0
    ? candidate.path
    : `${candidate.path} (${notes.join(", ")})`;
}

/** A read that found a folder should list it; a list that found a file should read it. */
function nextMove(tool: string, candidate: PathCandidate): string {
  if (tool === "os.fs.read" && candidate.kind === "folder") {
    return " with os.fs.list";
  }
  if (tool === "os.fs.list" && candidate.kind === "file") {
    return " with os.fs.read";
  }
  return "";
}
