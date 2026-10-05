import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { ApprovalCategory } from "../../../approval/approval-level.js";
import {
  requireFsApproval,
  type FsDangerousToolOptions,
} from "../fs-require-approval.js";

/**
 * Everything a git write tool needs to route itself through the
 * approval ladder. Mirrors `FsApprovalRequest`: the scope inputs
 * (`workingDir`, `trustConfigPaths`) travel with the prompt copy so a
 * call site cannot categorise against the wrong workspace or forget
 * the trust-config guard.
 */
export interface GitMutationApprovalRequest {
  sessionId: string;
  tool: string;
  /**
   * Absolute repository root — the directory that holds `.git`, or that
   * will receive it (`os.git.init`). A git mutation is categorised as a
   * file write to this directory: `fs_write_workspace` inside the
   * session cwd, `fs_write_home` under home, `other` elsewhere.
   */
  repoRoot: string;
  /** Short and specific, e.g. `git commit in /path/to/repo`. */
  reason: string;
  /** The exact git command line about to run. */
  preview: string;
  /** Session working directory — the workspace root for scope resolution. */
  workingDir: string;
  /**
   * Absolute paths of the agent's trust surface (`config.json`, `.env`),
   * injected from the bootstrap exactly like the fs tools receive them.
   * Omitted / empty disables the guard.
   */
  trustConfigPaths?: readonly string[];
}

/**
 * Single funnel every `os.git.*` write tool routes its approval through.
 * It reuses the fs funnel with `kind: "write"` against the repository
 * root, so a git mutation rides the same ladder rung as a file write in
 * that directory — silent from level 2 inside the workspace, level 3
 * under home, and asking on every level below 5 anywhere else.
 *
 * Trust-config guard: the fs funnel matches individual file targets, but
 * a git verb names a directory. A checkout in a repository that contains
 * the agent's own `config.json` / `.env` can rewrite those files from
 * another branch, which is the self-escalation the guard exists for. So
 * every trust path that lives inside the repository root is added to the
 * categorised targets, and the whole request becomes `trust_config`
 * (asks until level 5). Add and commit get the same rung in such a
 * repository — conservative on purpose; the case is rare (a repository
 * rooted at the state dir or at `$HOME`).
 *
 * Returns the category the operator approved; a denial throws
 * `ApprovalDeniedError` from the shared gate, same as the fs tools.
 */
export async function requireGitMutationApproval(
  options: FsDangerousToolOptions,
  request: GitMutationApprovalRequest,
  signal: AbortSignal,
): Promise<ApprovalCategory> {
  const trustPaths = request.trustConfigPaths ?? [];
  const trustInsideRepo = await trustConfigPathsInside(
    request.repoRoot,
    trustPaths,
  );
  const outcome = await requireFsApproval(
    options,
    {
      kind: "write",
      paths: [request.repoRoot, ...trustInsideRepo],
      sessionId: request.sessionId,
      tool: request.tool,
      reason: request.reason,
      preview: request.preview,
      affectedResources: [request.repoRoot],
      workingDir: request.workingDir,
      trustConfigPaths: trustPaths,
    },
    signal,
  );
  return outcome.category;
}

/**
 * Render a git argv as the command line the operator will see in the
 * approval prompt. Arguments that need quoting get POSIX single quotes
 * so a commit message with spaces reads as one token.
 */
export function formatGitCommandLine(args: readonly string[]): string {
  return ["git", ...args.map(quoteShellArg)].join(" ");
}

function quoteShellArg(arg: string): string {
  if (arg.length > 0 && /^[A-Za-z0-9_@%+=:,./~-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The subset of `trustPaths` that resolves to somewhere inside
 * `repoRoot`. Compared on canonical paths so a symlinked state dir or
 * repository is still caught; a path that does not exist yet (a fresh
 * `.env`, or an init target git is about to create) is canonicalised
 * through its deepest existing ancestor.
 */
async function trustConfigPathsInside(
  repoRoot: string,
  trustPaths: readonly string[],
): Promise<string[]> {
  if (trustPaths.length === 0) return [];
  const root = await canonicalizePath(repoRoot);
  const inside: string[] = [];
  for (const path of trustPaths) {
    const canonical = await canonicalizePath(path);
    if (isContained(root, canonical)) inside.push(path);
  }
  return inside;
}

async function canonicalizePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // Not on disk (yet): canonicalise the parent and re-attach the leaf.
  }
  const parent = dirname(path);
  if (parent === path) return path;
  return join(await canonicalizePath(parent), basename(path));
}

/** Boundary-safe containment: `child` equals `parent` or lives under it. */
function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}
