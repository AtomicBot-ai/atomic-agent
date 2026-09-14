import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { isInside } from "../../approval/fanout-scope.js";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../../compressor/result-compressor.js";
import { isFusionWorkerSessionId } from "../../session/fusion-worker-session.js";
import { resolveUserPath } from "../os/expand-home.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolRegistry,
} from "../tool-registry.js";

/**
 * Where a fusion worker may READ.
 *
 * Writes and commands were already confined — the fan-out's approval
 * names directories, and anything outside them hits the worker's refuse
 * policy. Reads never went through the gate at all, and a real run
 * showed what that costs: workers with thin briefs read
 * `../../01-cloud-flash/work/js/main.js` (a sibling benchmark's output)
 * and a harness screen dump, and spent their steps reverse-engineering
 * code that was not theirs to match.
 *
 * So a worker's filesystem reads must resolve inside its working
 * directory, or inside a directory this fan-out may write in (a worker
 * has to be able to read back what it was authorised to write, and a
 * fan-out scope can sit outside the working directory). This is scope
 * discipline against wandering, not a sandbox: a path that is inside
 * lexically OR by canonical (realpath) form is allowed, so a symlinked
 * `node_modules` keeps working and `/tmp` vs `/private/tmp` does not
 * refuse a path that is really inside.
 *
 * Only worker sessions are affected; every other session's reads are
 * untouched. The refusal is a tool result, not a throw, so it costs the
 * worker one step and reads as an instruction.
 */

type TargetsOf = (args: Record<string, unknown>) => string[];

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const pathArg: TargetsOf = (args) => {
  const path = nonEmpty(args.path);
  return path === undefined ? [] : [path];
};

/**
 * The read-class filesystem tools and the argument(s) naming what they
 * read. A search tool's omitted root is the working directory, which is
 * inside by definition, so it contributes nothing to check.
 */
export const WORKER_READ_TOOL_TARGETS: ReadonlyMap<string, TargetsOf> =
  new Map<string, TargetsOf>([
    ["os.fs.read", pathArg],
    ["os.fs.list", pathArg],
    ["os.fs.hash", pathArg],
    ["os.fs.watch", pathArg],
    ["os.fs.read_document", pathArg],
    ["os.fs.archive.list", pathArg],
    ["os.fs.archive.read_entry", pathArg],
    ["os.fs.grep", pathArg],
    [
      "os.fs.glob",
      // `cwd` wins over `path` inside the tool; either names the root.
      (args) => {
        const root = nonEmpty(args.cwd) ?? nonEmpty(args.path);
        return root === undefined ? [] : [root];
      },
    ],
    [
      "os.fs.diff",
      (args) =>
        [nonEmpty(args.aPath), nonEmpty(args.bPath)].filter(
          (path): path is string => path !== undefined,
        ),
    ],
    [
      "vision.describe",
      (args) =>
        [
          nonEmpty(args.path),
          ...(Array.isArray(args.paths) ? args.paths.map(nonEmpty) : []),
        ].filter((path): path is string => path !== undefined),
    ],
    [
      // A syntax check reads every file it is handed.
      "verify.syntax",
      (args) =>
        (Array.isArray(args.files) ? args.files.map(nonEmpty) : []).filter(
          (path): path is string => path !== undefined,
        ),
    ],
  ]);

/** `https://…`, `data:…` — not a filesystem path, not this module's business. */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:(?:\/\/|[^\\/])/i;

export const WORKER_READ_REFUSAL_REASON = "worker-read-outside-scope";

/**
 * The realpath of the deepest existing ancestor with the rest appended,
 * so a path that does not exist yet still canonicalises.
 */
function canonical(path: string): string {
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
  const targetsOf = WORKER_READ_TOOL_TARGETS.get(tool);
  if (targetsOf === undefined) return null;
  const roots = [ctx.workingDir, ...grantedDirs];
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
    if (!isOutsideReadRoots(absolute, roots)) continue;
    const alsoScope =
      grantedDirs.length > 0
        ? ` or the directories this fan-out may write in (${grantedDirs.join(", ")})`
        : "";
    const output =
      `${tool} refused: ${absolute} is outside this worker's working directory (${ctx.workingDir})${alsoScope}, and a worker reads only inside those. ` +
      `Do not search elsewhere for context: use your task, its FILES and the original request, and name anything missing in your reply.`;
    return compressToolResult(
      {
        tool,
        status: "error",
        output,
        details: {
          reason: WORKER_READ_REFUSAL_REASON,
          path: absolute,
          allowedRoots: roots,
        },
      },
      // Paths are long; a clipped refusal loses the instruction at its end.
      { maxSummaryLength: Math.max(1000, output.length + 50) },
    );
  }
  return null;
}

/** Definitions this module produced, so a second install does not wrap twice. */
const CONFINED = new WeakSet<ToolDefinition>();

/**
 * Wrap every registered read-class tool so a worker session's call is
 * checked before it runs. Call once, after the native tools are
 * registered. Returns the names it confined.
 *
 * Wrapping at the registry rather than inside each tool keeps the rule
 * in one place owned by fusion, and `registry.invoke` is the single
 * path every call — native, batched, or recovered from text — takes.
 */
export function confineWorkerReads(
  registry: Pick<ToolRegistry, "has" | "get" | "register">,
  options: { grantedDirs: (sessionId: string) => readonly string[] },
): string[] {
  const confined: string[] = [];
  for (const name of WORKER_READ_TOOL_TARGETS.keys()) {
    if (!registry.has(name)) continue;
    const inner = registry.get(name);
    confined.push(name);
    if (CONFINED.has(inner)) continue;
    const wrapped: ToolDefinition = {
      ...inner,
      run: async (args, ctx) =>
        checkWorkerRead(name, args, ctx, options.grantedDirs(ctx.sessionId)) ??
        inner.run(args, ctx),
    };
    CONFINED.add(wrapped);
    registry.register(wrapped);
  }
  return confined;
}
