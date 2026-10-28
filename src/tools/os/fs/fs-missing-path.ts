import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";

import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import { isFusionWorkerSessionId } from "../../../session/fusion-worker-session.js";
import {
  isScratchPath,
  isUnderAny,
  sessionReadRoots,
} from "../../read-scope/index.js";
import type { ToolContext } from "../../tool-registry.js";
import {
  candidateRoots,
  type CandidatePlan,
} from "./path-candidate-roots.js";
import {
  candidateName,
  findPathCandidates,
  type CandidateSearch,
  type PathCandidate,
} from "./path-candidates.js";

/**
 * The answer a read-class tool gives for a path that does not exist: a
 * tool result (not a throw, so the compressor's short error cap cannot
 * cut it) saying, as advice, where something with that name is
 * (ATO-413). `details` carry the error code and the path for the log;
 * nothing here ever carries file contents.
 */

/** Candidates shown in one result; the rest are counted, not listed. */
const MAX_SHOWN = 5;

/** Codes that mean "nothing at this path". */
const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);

type MissingPathContext = Pick<
  ToolContext,
  "workingDir" | "readRoots" | "sessionId"
>;

/** A missing path, already answered. */
export interface MissingPath {
  missing: CompressedToolResult;
}

/** Whether `err` means the path is not there (ENOENT, or ENOTDIR: a part of it is a file). */
export function isMissingPathError(err: unknown): boolean {
  return MISSING_CODES.has(errorCode(err) ?? "");
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Run `op` on `absolute`; when it fails because the path is not there,
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
    return { missing: await missingPathResult(tool, absolute, ctx, errorCode(err)) };
  }
}

/**
 * For a tool that tolerates an unreadable root (glob walks on and finds
 * nothing): the missing-path answer when `absolute` is not there,
 * otherwise `null`, leaving every other outcome to the tool as before.
 */
export async function missingRoot(
  tool: string,
  absolute: string,
  ctx: MissingPathContext,
): Promise<CompressedToolResult | null> {
  const code = await stat(absolute).then(
    () => undefined,
    (err: unknown) => (isMissingPathError(err) ? errorCode(err) : undefined),
  );
  return code === undefined ? null : missingPathResult(tool, absolute, ctx, code);
}

export async function missingPathResult(
  tool: string,
  absolute: string,
  ctx: MissingPathContext,
  code = "ENOENT",
  plan?: CandidatePlan,
): Promise<CompressedToolResult> {
  const worker = isFusionWorkerSessionId(ctx.sessionId);
  const isInScope = (path: string) => inScope(path, ctx);
  // A worker's world is its task's folders and nobody is there to ask:
  // it is told the path is missing, not where else to look.
  const search: CandidateSearch = worker
    ? { found: [], complete: true }
    : await searchNear(absolute, plan ?? (await defaultPlan(absolute, ctx)), isInScope);
  const output = missingPathMessage(tool, absolute, search, isInScope, {
    worker,
    code,
  });
  return compressToolResult(
    {
      tool,
      status: "error",
      output,
      details: {
        path: absolute,
        errorCode: code,
        candidates: search.found.map((c) => c.path),
      },
    },
    { maxSummaryLength: Math.max(1000, output.length + 50), maxTailLines: 20 },
  );
}

function searchNear(
  absolute: string,
  plan: CandidatePlan,
  isInScope: (path: string) => boolean,
): Promise<CandidateSearch> {
  return findPathCandidates(absolute, plan.roots, undefined, {
    blocked: plan.blocked,
    // Dot-names outside the scope (.ssh, an .env elsewhere) are never offered.
    accept: (c) => isInScope(c.path) || !basename(c.path).startsWith("."),
  });
}

function defaultPlan(
  absolute: string,
  ctx: MissingPathContext,
): Promise<CandidatePlan> {
  return candidateRoots({
    missing: absolute,
    workingDir: ctx.workingDir,
    readRoots: ctx.readRoots,
    home: homedir(),
    oneDrive: process.env.OneDrive,
  });
}

/**
 * Inside the working folder, a path the user named, or scratch space.
 * Folders approved earlier in the session and `agent.readScope:
 * "unrestricted"` are not visible from here, so such a path is still
 * called outside; the wording only says reading it will ask.
 */
function inScope(path: string, ctx: MissingPathContext): boolean {
  return isUnderAny(path, sessionReadRoots(ctx)) || isScratchPath(path);
}

const REASONS: Record<string, string> = {
  ENOENT: "ENOENT: no such file or directory",
  ENOTDIR: "ENOTDIR: a part of the path is a file, not a folder",
};

/**
 * Advisory wording: the model may only have been checking whether the
 * path exists, so the candidates are offered, not pressed. Several fit:
 * ask the user. None: do not retry the same path. The advice comes
 * before the list, so a clipped result still carries it.
 */
export function missingPathMessage(
  tool: string,
  absolute: string,
  search: CandidateSearch,
  isInScope: (path: string) => boolean,
  options: { worker?: boolean; code?: string } = {},
): string {
  const code = options.code ?? "ENOENT";
  const head = `${tool}: ${absolute} does not exist (${REASONS[code] ?? code}).`;
  if (options.worker === true) {
    return `${head} Do not search elsewhere; name it as missing in your reply.`;
  }
  const name = candidateName(absolute) ?? absolute;
  const { found } = search;
  if (found.length === 0) {
    const searched = search.complete
      ? `Nothing named "${name}" was found nearby.`
      : `A quick search found nothing named "${name}".`;
    return `${head} ${searched} Do not retry the same path.`;
  }
  const shown = found.slice(0, MAX_SHOWN);
  const list = shown.map((c) => `- ${describe(c, isInScope)}`);
  if (found.length > MAX_SHOWN) list.push("- … and more");
  const folderNote =
    tool === "os.fs.read" && shown.some((c) => c.kind === "folder")
      ? " A folder is listed with os.fs.list, not read."
      : "";
  return (
    `${head} Something named "${name}" exists elsewhere. ` +
    "If you meant one of these, use it (ask the user if several fit); " +
    `if you were only checking whether it exists, it does not.${folderNote}\n` +
    list.join("\n")
  );
}

function describe(
  candidate: PathCandidate,
  isInScope: (path: string) => boolean,
): string {
  const notes: string[] = [];
  if (candidate.kind !== "other") notes.push(candidate.kind);
  if (!isInScope(candidate.path)) {
    notes.push(
      "outside the working folder; reading it will ask the user for permission",
    );
  }
  return notes.length === 0
    ? candidate.path
    : `${candidate.path} (${notes.join(", ")})`;
}
