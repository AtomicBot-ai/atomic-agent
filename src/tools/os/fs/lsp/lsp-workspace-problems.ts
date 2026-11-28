/**
 * The workspace's problems for `@problems` (ATO-2472, after Continue's
 * @Problems and the Problems panel of VS Code / Cursor): the errors and
 * warnings the language servers of the shared pool know for files inside
 * one working folder.
 *
 * Two sources, merged by file:
 *  - what the running servers already published (files the agent edited
 *    or navigated this session), read from `DiagnosticsClient.published`;
 *  - a fresh check of the files the person changed (`changedFiles`, from
 *    git), at most MAX_CHECKED_FILES of them, each through the pool the
 *    way an edit is checked.
 *
 * Rules, all of them on purpose:
 *  - nothing outside the working folder is reported or read;
 *  - no start question: the check passes no session, so a server starts
 *    only where one may start unasked (a trusted folder, or a folder
 *    whose question was already answered yes); elsewhere it stays off;
 *  - bounded: a total time budget, a file cap, a byte cap per file read;
 *    what is not known in time is left out, never waited for.
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { LspDiagnostic } from "./lsp-delta.js";
import type { LspServerPool } from "./lsp-server-pool.js";
import { serverForPath } from "./lsp-servers.js";

/** Most changed files checked afresh for one `@problems`. */
export const MAX_CHECKED_FILES = 20;
/** The whole collection stops waiting after this long. */
export const PROBLEMS_BUDGET_MS = 8000;
/** How long one file check may wait for a server still starting. */
export const PROBLEMS_STARTUP_WAIT_MS = 4000;
/** How long one file check may wait for the server's verdict. */
export const PROBLEMS_DIAGNOSE_MS = 3000;
/** Larger changed files are not sent to a server. */
export const PROBLEMS_MAX_FILE_BYTES = 1024 * 1024;

/** One file's problems, its path relative to the working folder with `/`. */
export interface FileProblems {
  readonly path: string;
  readonly diagnostics: readonly LspDiagnostic[];
}

export type WorkspaceProblems =
  /** `tools.lsp.enabled` is off: no pool at all. */
  | { readonly state: "off" }
  /** No server is up for this folder and none could be started unasked. */
  | { readonly state: "no_server" }
  | { readonly state: "ok"; readonly servers: readonly string[]; readonly files: readonly FileProblems[] };

export interface WorkspaceProblemsOptions {
  /** The shared pool; null when language servers are off. */
  readonly pool: LspServerPool | null;
  /** The working folder, absolute. */
  readonly workingDir: string;
  /** Changed files, relative to `workingDir`; rejects or [] outside a checkout. */
  readonly changedFiles: () => Promise<readonly string[]>;
  readonly budgetMs?: number;
  readonly now?: () => number;
}

/** `path` relative to `root` with `/`, or null when it is not inside. */
function insideRel(root: string, path: string): string | null {
  const rel = relative(root, path);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split("\\").join("/");
}

async function readSmall(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > PROBLEMS_MAX_FILE_BYTES) return null;
    const buf = await readFile(path);
    return buf.includes(0) ? null : buf.toString("utf8");
  } catch {
    return null;
  }
}

/** `promise`, or `fallback` once `ms` has passed. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((done) => {
    const timer = setTimeout(() => done(fallback), Math.max(0, ms));
    promise.then(
      (v) => { clearTimeout(timer); done(v); },
      () => { clearTimeout(timer); done(fallback); },
    );
  });
}

export async function collectWorkspaceProblems(options: WorkspaceProblemsOptions): Promise<WorkspaceProblems> {
  const { pool, workingDir } = options;
  if (pool === null) return { state: "off" };
  const root = resolve(workingDir);
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? PROBLEMS_BUDGET_MS);
  const byPath = new Map<string, readonly LspDiagnostic[]>();
  const servers = new Set<string>();

  const changed = await within(options.changedFiles(), deadline - now(), [] as readonly string[]);
  const checks = changed
    .map((rel) => resolve(root, rel))
    .filter((abs) => insideRel(root, abs) !== null && serverForPath(abs) !== null)
    .slice(0, MAX_CHECKED_FILES)
    .map(async (abs) => {
      const text = await readSmall(abs);
      if (text === null) return;
      const result = await pool.withServer(abs, {}, PROBLEMS_STARTUP_WAIT_MS, async ({ client, spec }) => {
        servers.add(spec.id);
        return client.diagnose(abs, spec.languageId(abs), text, PROBLEMS_DIAGNOSE_MS);
      });
      const rel = insideRel(root, abs);
      if (result.ok && result.value !== null && rel !== null) byPath.set(rel, result.value);
    });
  await within(Promise.all(checks).then(() => undefined), deadline - now(), undefined);

  for (const server of pool.running()) {
    const published = server.client.published?.() ?? [];
    if (insideRel(server.root, root) === null && resolve(server.root) !== root && insideRel(root, server.root) === null) continue;
    servers.add(server.spec.id);
    for (const file of published) {
      const rel = insideRel(root, file.path);
      // A fresh check of the file wins over what was published before it.
      if (rel !== null && !byPath.has(rel)) byPath.set(rel, file.diagnostics);
    }
  }
  if (servers.size === 0) return { state: "no_server" };
  const files = [...byPath]
    .filter(([, diagnostics]) => diagnostics.length > 0)
    .map(([path, diagnostics]) => ({ path, diagnostics }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { state: "ok", servers: [...servers].sort(), files };
}
