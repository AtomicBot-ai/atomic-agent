import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Workspace fingerprint for the test-repeat detector (issue #118).
 *
 * A stat-walk over the resolved test cwd hashing `path + size + mtimeMs`
 * per file. Because it observes the filesystem itself — not an internal
 * "write tool called" counter — mutations by Atomic tools, shell
 * commands, and external processes all change the fingerprint, and a
 * same-size replacement is caught via mtime.
 *
 * The walk is invoked lazily: only when a recognized test command is
 * about to dispatch (see `runSyncLoopGate`), never on ordinary shell
 * calls.
 */

/**
 * Directory basenames excluded from the fingerprint. Mirrors the
 * documented `DEFAULT_IGNORE` globs of `os.fs.glob`
 * (`src/tools/os/fs-glob.ts`): dependency stores, VCS metadata, build
 * outputs, and tool caches — churn there (a test run repopulating
 * `.pytest_cache/` or `coverage/`) must not masquerade as source
 * progress.
 */
export const FINGERPRINT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "Library",
  ".rustup",
  ".cargo",
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".gradle",
  ".m2",
  "__pycache__",
  "site-packages",
  "vendor",
  ".venv",
  "venv",
  ".tox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".terraform",
  ".idea",
  ".vscode",
  ".Trash",
  ".svn",
  ".hg",
]);

/**
 * File basenames excluded from the fingerprint: root-level artifacts the
 * recognized runners rewrite on every run even when no source changed.
 * A `.coverage.*` prefix match covers pytest-cov's parallel-mode files.
 */
export const FINGERPRINT_IGNORED_FILES: ReadonlySet<string> = new Set([
  ".coverage",
  "coverage.xml",
  "lcov.info",
  "junit.xml",
  ".DS_Store",
]);

/**
 * Walk ceiling. A tree still yielding files past this many is too large
 * to fingerprint reliably in-line, so `fingerprintWorkspace` returns
 * `null` and the (warn-only) detector simply stays silent for that cwd —
 * a false negative is preferred over both a false warning and a slow
 * gate.
 */
const MAX_FINGERPRINT_FILES = 25_000;

function isIgnoredFile(name: string): boolean {
  return FINGERPRINT_IGNORED_FILES.has(name) || name.startsWith(".coverage.");
}

/**
 * Fingerprint the workspace rooted at `root`. Deterministic for an
 * unchanged tree (entries are visited in sorted order); any file
 * addition, removal, rename, size change, or mtime change under a
 * non-ignored path yields a different digest.
 *
 * Returns `null` when `root` is missing / not a directory / oversized —
 * callers must treat `null` as "cannot observe the workspace" and skip
 * repeat detection entirely. Unreadable subdirectories and files that
 * vanish mid-walk are skipped; symlinks are not followed (cycle safety).
 */
export function fingerprintWorkspace(root: string): string | null {
  try {
    if (!statSync(root).isDirectory()) return null;
  } catch {
    return null;
  }
  const hash = createHash("sha1");
  let fileCount = 0;
  let truncated = false;

  const walk = (dir: string, rel: string): void => {
    if (truncated) return;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of dirents) {
      if (truncated) return;
      const name = entry.name;
      const childRel = rel.length === 0 ? name : `${rel}/${name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (FINGERPRINT_IGNORED_DIRS.has(name)) continue;
        walk(join(dir, name), childRel);
        continue;
      }
      if (!entry.isFile() || isIgnoredFile(name)) continue;
      let stats;
      try {
        stats = statSync(join(dir, name));
      } catch {
        continue;
      }
      fileCount += 1;
      if (fileCount > MAX_FINGERPRINT_FILES) {
        truncated = true;
        return;
      }
      hash.update(`${childRel}:${stats.size}:${stats.mtimeMs}\n`);
    }
  };

  walk(root, "");
  if (truncated) return null;
  return hash.digest("hex").slice(0, 16);
}
