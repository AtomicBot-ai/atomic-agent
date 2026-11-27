/**
 * ATO-2445: the project tree in the Files panel, one folder at a time.
 *
 * The tree shows the chat's working folder, the same folder @-mentions list
 * (file-mentions.ts), and is read lazily: the window asks for one folder
 * when it is opened, never the whole project. What a folder shows:
 *
 *   - its own entries (readdir), folders first, then names in the reader's
 *     order with digits as numbers, at most TREE_MAX_ENTRIES;
 *   - in a git checkout, minus what .gitignore leaves out (`git
 *     check-ignore`, as `git ls-files --exclude-standard` does for the
 *     mentions) and `.git` itself; outside one, minus the folders the
 *     mention walk skips (node_modules, dist, build, .venv…);
 *   - each changed file's git mark (M, A, R, U for untracked, C for a
 *     conflict), and a dot on a folder with changes inside.
 *
 * Read scope: the folder must lie inside the preview's roots (file-preview.ts
 * previewRootsFor: home, the agent's folders, temp); a path asked for must
 * stay inside the tree's root, as written and after links are resolved, so
 * a link to a folder elsewhere is shown but not opened. A file picked opens
 * through the preview's own check as ever.
 *
 * No Electron import, so the unit suite loads it from `out/main`.
 */

import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";

import { SKIPPED_DIRS } from "./file-mentions.js";
import { gitIgnored, gitPrefix, gitStatus, runGitCode, type Git, type GitMark } from "./project-tree-git.js";
import { isUnder, pathFor, type Platform } from "./platform.js";

export const TREE_MAX_ENTRIES = 2000;

export type TreeEntry = {
  name: string;
  /** The path under the tree's root, `/`-separated. */
  rel: string;
  dir: boolean;
  /** The file's git mark. */
  mark?: GitMark;
  /** A folder with changed files inside. */
  changed?: boolean;
};

export type TreeResult =
  | { ok: true; root: string; rel: string; entries: TreeEntry[]; cut: boolean; git: boolean }
  | { ok: false; reason: "outside" | "missing" | "not-dir" };

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** `rel` as the window sent it: `/`-separated, no leading or trailing slash, no `.` or `..` parts; null when it is not one. */
export function cleanRel(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string" || raw.length > 4096 || /[\0\r\n]/.test(raw)) return null;
  const parts = raw.replace(/\\/g, "/").split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

/** Entries in the tree's order: folders first, then by name with digits as numbers. */
export function sortEntries(list: TreeEntry[]): TreeEntry[] {
  return list.sort((a, b) => (a.dir === b.dir ? COLLATOR.compare(a.name, b.name) || (a.name < b.name ? -1 : 1) : a.dir ? -1 : 1));
}

/** One folder of the tree rooted at `root`; `roots` are the preview's. */
export async function listTreeDir(
  root: string,
  rawRel: unknown,
  roots: readonly string[],
  platform: Platform,
  opts: { git?: Git | null; max?: number } = {},
): Promise<TreeResult> {
  const P = pathFor(platform);
  const rel = cleanRel(rawRel);
  if (rel === null) return { ok: false, reason: "outside" };
  const base = P.resolve(root);
  if (!roots.some((r) => r && isUnder(platform, P.resolve(r), base))) return { ok: false, reason: "outside" };
  const realBase = await realpath(base).catch(() => null);
  if (!realBase) return { ok: false, reason: "missing" };
  const dir = rel ? P.join(base, ...rel.split("/")) : base;
  const realDir = await realpath(dir).catch(() => null);
  if (!realDir) return { ok: false, reason: "missing" };
  if (!isUnder(platform, realBase, realDir) && !isUnder(platform, base, realDir)) return { ok: false, reason: "outside" };
  const st = await stat(realDir).catch(() => null);
  if (!st) return { ok: false, reason: "missing" };
  if (!st.isDirectory()) return { ok: false, reason: "not-dir" };
  let dirents: Dirent[];
  try { dirents = await readdir(realDir, { withFileTypes: true }); } catch { return { ok: false, reason: "missing" }; }

  const git = opts.git === undefined ? runGitCode : opts.git;
  const prefix = git ? await gitPrefix(git, base) : null;
  const inGit = prefix !== null;
  const entries: TreeEntry[] = [];
  for (const d of dirents) {
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      const t = await stat(P.join(realDir, d.name)).catch(() => null);
      if (!t) continue;
      isDir = t.isDirectory();
    } else if (!isDir && !d.isFile()) continue;
    if (d.name === ".git" || (!inGit && isDir && SKIPPED_DIRS.has(d.name))) continue;
    entries.push({ name: d.name, rel: rel ? `${rel}/${d.name}` : d.name, dir: isDir });
  }
  let shown = entries;
  if (prefix !== null && git && entries.length) {
    // A folder goes with a trailing slash, so a `build/` pattern matches it.
    const ignored = await gitIgnored(git, base, entries.map((e) => (e.dir ? e.rel + "/" : e.rel)));
    shown = entries.filter((e) => !ignored.has(e.rel));
    const marks = await gitStatus(git, base, prefix, rel ? `:(literal)${rel}` : ".");
    for (const e of shown) {
      if (!e.dir) { const m = marks.get(e.rel); if (m) e.mark = m; continue; }
      for (const p of marks.keys()) if (p.startsWith(e.rel + "/")) { e.changed = true; break; }
    }
  }
  sortEntries(shown);
  const max = opts.max ?? TREE_MAX_ENTRIES;
  return { ok: true, root: base, rel, entries: shown.slice(0, max), cut: shown.length > max, git: inGit };
}
