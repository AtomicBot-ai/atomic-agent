import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import { isInside } from "../../approval/fanout-scope.js";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../../compressor/result-compressor.js";
import { isFusionWorkerSessionId } from "../../session/fusion-worker-session.js";
import { resolveUserPath } from "../os/expand-home.js";
import type { ToolContext } from "../tool-registry.js";
import { READ_TOOL_TARGETS, URL_LIKE } from "./read-scope-targets.js";

/**
 * Where a session may READ.
 *
 * Writes and commands were always gated; reads never were, and a real
 * run showed what that costs: a plain session read a sibling run's
 * solution, a harness's screen dumps and the benchmark's own checker
 * from far outside its working directory, and fusion workers with thin
 * briefs spent their steps reverse-engineering code that was not theirs
 * to match.
 *
 * So by default (`agent.readScope: "working-dir"`) a session's
 * filesystem reads must resolve inside its working directory, under a
 * path the user named in their own messages (`ctx.readRoots`,
 * `read-scope-roots.ts`), or under a directory the operator approved
 * earlier this session (`ReadScopeGrants`); anything else ASKS through
 * the approval ladder as `fs_read_outside` (`read-scope-approval.ts`)
 * and is refused only when the operator says no. A fusion worker's
 * reads stay inside its working directory or a directory its fan-out
 * may write in — the worker rule is the older and narrower one, a hard
 * refusal (an ephemeral session has nobody to ask), and it never widens
 * from the brief, which is model output. This is scope discipline
 * against wandering, not a sandbox: a path that is inside lexically OR
 * by canonical (realpath) form is allowed, so a symlinked
 * `node_modules` keeps working and `/tmp` vs `/private/tmp` does not
 * question a path that is really inside. The OS temp directory is
 * scratch space — a helper written to `/tmp` and run, an output
 * redirected there and read back — and is always in scope for a
 * session; the threat was other users' homes and a benchmark's sibling
 * trees, never scratch. A refusal is a tool result, not a throw, so it
 * costs one step and reads as an instruction: ask the user, or opt out
 * with `agent.readScope: "unrestricted"`.
 */

export const READ_REFUSAL_REASON = "read-outside-scope";
export const WORKER_READ_REFUSAL_REASON = "worker-read-outside-scope";

/**
 * The realpath of the deepest existing ancestor with the rest appended,
 * so a path that does not exist yet still canonicalises.
 */
export function canonical(path: string): string {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return resolve(realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** Whether absolute `target` lies outside every root, lexically and canonically. */
export function isOutsideReadRoots(
  target: string,
  roots: readonly string[],
): boolean {
  if (roots.some((root) => isInside(resolve(root), target))) return false;
  const real = canonical(target);
  return !roots.some((root) => isInside(canonical(resolve(root)), real));
}

/** Whether `path` is under any of `prefixes`, lexically or canonically. */
export function isUnderAny(path: string, prefixes: readonly string[]): boolean {
  if (prefixes.some((prefix) => isInside(prefix, path))) return true;
  const real = canonical(path);
  return prefixes.some((prefix) => isInside(canonical(prefix), real));
}

/**
 * The OS temp directory, plus the conventional POSIX ones — macOS's
 * `os.tmpdir()` is a per-user folder, and models write to `/tmp`. Read
 * per call so a test (or an operator) steering `TMPDIR` is honoured.
 */
export function scratchDirs(): string[] {
  return process.platform === "win32"
    ? [tmpdir()]
    : [tmpdir(), "/tmp", "/var/tmp"];
}

/** Scratch space: always in scope for a session, whatever the roots. */
export function isScratchPath(path: string): boolean {
  return isUnderAny(path, scratchDirs());
}

/** A session's roots: the working directory plus the paths the user named. */
export function sessionReadRoots(
  ctx: Pick<ToolContext, "workingDir" | "readRoots">,
): string[] {
  return [ctx.workingDir, ...(ctx.readRoots ?? [])];
}

// Paths are long; a clipped refusal loses the instruction at its end.
const uncut = (output: string) => ({
  maxSummaryLength: Math.max(1000, output.length + 50),
});

/** The refusal for a worker read outside its working directory and fan-out scope. */
export function workerReadRefusal(
  tool: string,
  path: string,
  ctx: Pick<ToolContext, "workingDir">,
  grantedDirs: readonly string[],
): CompressedToolResult {
  const alsoScope =
    grantedDirs.length > 0
      ? ` or the directories this fan-out may write in (${grantedDirs.join(", ")})`
      : "";
  const output =
    `${tool} refused: ${path} is outside this worker's working directory (${ctx.workingDir})${alsoScope}, and a worker reads only inside those. ` +
    `Do not search elsewhere for context: use your task, its FILES and the original request, and name anything missing in your reply.`;
  return compressToolResult(
    {
      tool,
      status: "error",
      output,
      details: {
        reason: WORKER_READ_REFUSAL_REASON,
        path,
        allowedRoots: [ctx.workingDir, ...grantedDirs],
      },
    },
    uncut(output),
  );
}

/**
 * The refusal for a session read outside its roots — the operator said
 * no at the `fs_read_outside` prompt, or there was no ladder to ask.
 */
export function sessionReadRefusal(
  tool: string,
  path: string,
  ctx: Pick<ToolContext, "workingDir">,
  roots: readonly string[],
): CompressedToolResult {
  const output = `${tool} refused: reads are confined to the working directory (${ctx.workingDir}) and the paths the user named; ask the user to name ${path} or to set agent.readScope: unrestricted`;
  return compressToolResult(
    {
      tool,
      status: "error",
      output,
      details: { reason: READ_REFUSAL_REASON, path, allowedRoots: [...roots] },
    },
    uncut(output),
  );
}

/**
 * The first target of a read tool call that resolves outside every root,
 * or `null`. With `scratchInScope`, the temp directory never counts as
 * outside.
 */
function firstTargetOutside(
  tool: string,
  args: Record<string, unknown>,
  ctx: Pick<ToolContext, "workingDir">,
  roots: readonly string[],
  scratchInScope: boolean,
): string | null {
  const targetsOf = READ_TOOL_TARGETS.get(tool);
  if (targetsOf === undefined) return null;
  for (const raw of targetsOf(args)) {
    if (URL_LIKE.test(raw)) continue;
    let absolute: string;
    try {
      absolute = resolveUserPath(raw, ctx.workingDir);
    } catch {
      // Unresolvable here means unresolvable in the tool too; its own
      // error is the better message.
      continue;
    }
    if (scratchInScope && isScratchPath(absolute)) continue;
    if (isOutsideReadRoots(absolute, roots)) return absolute;
  }
  return null;
}

/**
 * The refusal for a worker read outside its roots, or `null` when the
 * call may run (not a worker, not a read tool, or every target inside).
 */
export function checkWorkerRead(
  tool: string,
  args: Record<string, unknown>,
  ctx: Pick<ToolContext, "sessionId" | "workingDir">,
  grantedDirs: readonly string[],
): CompressedToolResult | null {
  if (!isFusionWorkerSessionId(ctx.sessionId)) return null;
  // The worker rule predates the session one and keeps its shape: no
  // scratch allowance — a worker's world is its task's directories.
  const outside = firstTargetOutside(
    tool,
    args,
    ctx,
    [ctx.workingDir, ...grantedDirs],
    false,
  );
  return outside === null
    ? null
    : workerReadRefusal(tool, outside, ctx, grantedDirs);
}

/**
 * The first path a session read names outside `roots` — the working
 * directory, the paths the user named and the directories approved so
 * far (`sessionReadRoots` plus `ReadScopeGrants`) — or `null` when the
 * call may run. The caller asks about it (`read-scope-approval.ts`).
 * A worker session is not this check's business (`checkWorkerRead` is
 * narrower and refuses outright).
 */
export function findSessionReadOutside(
  tool: string,
  args: Record<string, unknown>,
  ctx: Pick<ToolContext, "sessionId" | "workingDir">,
  roots: readonly string[],
): string | null {
  if (isFusionWorkerSessionId(ctx.sessionId)) return null;
  return firstTargetOutside(tool, args, ctx, roots, true);
}
