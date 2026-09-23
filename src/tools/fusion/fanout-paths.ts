import { dirname, isAbsolute, resolve, sep } from "node:path";
import { homedir } from "node:os";

import { isInside } from "../../approval/fanout-scope.js";
import { resolveUserPath } from "../os/expand-home.js";
import type { DelegateTask } from "./delegate-args.js";

/**
 * Where a fan-out is about to write — the directory the operator is
 * asked about once, and the scope its workers then inherit.
 *
 * There is no field that states this, so it is derived, in this order:
 *
 * 1. **`task.files`.** The brief's own list of paths. This is the answer
 *    when the orchestrator fills it in, and the `### fusion` guidance now
 *    tells it to.
 * 2. **Paths written in the instructions.** In the session that exposed
 *    all of this, the orchestrator put every path in prose —
 *    `"Write two files: /tmp/rel-2/cart.js …"` — and left `files` empty.
 *    Refusing to read that would have meant no scope and no fix, so a
 *    deliberately strict pattern picks absolute paths out of the text.
 * 3. **The working directory**, as the floor. A fan-out that names
 *    nothing still needs somewhere to work.
 *
 * Then the directories are collapsed to their shallowest members, so a
 * fan-out writing `/tmp/x/a.js` and `/tmp/x/sub/b.js` is one scope, not
 * two.
 */

/**
 * Absolute paths, or `./`-relative ones carrying a file extension.
 *
 * Strict on purpose. This runs over a model's prose, where a loose
 * pattern would find version numbers, package names and sentence
 * fragments, and every false positive widens what the operator is about
 * to authorise. A miss is cheap — the working directory still floors the
 * scope — so the pattern errs towards missing.
 */
const PATH_IN_PROSE =
  /(?:^|[\s"'`(])((?:\/|\.\/|~\/)[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z0-9]{1,8})/g;

/** Roots too broad to hand to a fan-out, however the brief was written. */
function isTooBroad(dir: string): boolean {
  const home = homedir();
  return dir === sep || dir === home || dir === resolve(home, "..");
}

function collectFromText(text: string, workingDir: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(PATH_IN_PROSE)) {
    const raw = match[1];
    if (raw === undefined) continue;
    try {
      out.push(resolveUserPath(raw, workingDir));
    } catch {
      // `resolveUserPath` throws only on a Unix-absolute path under
      // Windows. A path we cannot resolve is a path we will not grant.
    }
  }
  return out;
}

/**
 * Collapse directories to the shallowest that cover them all, and drop
 * anything too broad to authorise.
 */
export function collapseScope(dirs: readonly string[]): string[] {
  const unique = [...new Set(dirs)].filter((dir) => !isTooBroad(dir));
  const roots: string[] = [];
  for (const dir of unique.sort((a, b) => a.length - b.length)) {
    if (!roots.some((root) => isInside(root, dir))) roots.push(dir);
  }
  return roots;
}

/**
 * The directories a fan-out may write in, or an empty array when the
 * brief gives nothing safe to grant — in which case the workers keep
 * asking (and being refused), which the operator sees immediately as
 * every task coming back `needs_orchestrator`.
 */
export function resolveFanoutScope(
  tasks: readonly DelegateTask[],
  workingDir: string,
): string[] {
  const paths: string[] = [];
  for (const task of tasks) {
    for (const file of task.files ?? []) {
      try {
        paths.push(resolveUserPath(file, workingDir));
      } catch {
        // See `collectFromText`.
      }
    }
    paths.push(...collectFromText(task.instructions, workingDir));
    if (task.deliverable) {
      paths.push(...collectFromText(task.deliverable, workingDir));
    }
  }
  const dirs = paths.map((path) => (isAbsolute(path) ? dirname(path) : path));
  dirs.push(workingDir);
  return collapseScope(dirs);
}
