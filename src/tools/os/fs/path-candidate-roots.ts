import { stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import { isInside } from "../../../approval/fanout-scope.js";

/**
 * Which folders a missing-path search may list (`path-candidates.ts`).
 *
 * Near what the session already touches, never the whole home: the
 * working folder, the paths the user named, and the nearest existing
 * ancestor of the missing path with a level or two above it. On macOS,
 * listing Desktop, Documents, Downloads (and Pictures, Movies, Music)
 * makes the desktop app ask for permission, and a "Don't Allow" sticks.
 * So such a folder is searched, or even descended into, only when the
 * missing path, the working folder or a user-named path is already
 * inside it; otherwise it is blocked.
 */

/** One directory to search and how many levels below it to look. */
export interface CandidateRoot {
  dir: string;
  /** 1 = the root's direct children only. */
  depth: number;
}

export interface CandidatePlan {
  roots: CandidateRoot[];
  /** Folders the search must neither list nor descend into. */
  blocked: string[];
}

export interface CandidateRootInput {
  missing: string;
  workingDir: string;
  readRoots?: readonly string[];
  home: string;
  platform?: NodeJS.Platform;
  /** Windows' OneDrive folder (`%OneDrive%`), when there is one. */
  oneDrive?: string;
  /** Test seam; defaults to `stat`. */
  exists?: (path: string) => Promise<boolean>;
}

const WORKING_DEPTH = 3;
const NAMED_DEPTH = 2;
const PROTECTED_DEPTH = 3;

/** Folders whose listing the OS guards; the first three are also search roots. */
function protectedFolders(input: CandidateRootInput): {
  searchable: string[];
  guarded: string[];
} {
  const { home } = input;
  const searchable = ["Desktop", "Documents", "Downloads"].map((n) => join(home, n));
  const guarded = ["Pictures", "Movies", "Music"].map((n) => join(home, n));
  if ((input.platform ?? process.platform) === "win32") {
    const oneDrives = [join(home, "OneDrive"), input.oneDrive].filter(
      (dir): dir is string => typeof dir === "string" && dir.length > 0,
    );
    for (const oneDrive of new Set(oneDrives)) {
      searchable.push(join(oneDrive, "Desktop"), join(oneDrive, "Documents"));
    }
  }
  return { searchable, guarded };
}

export async function candidateRoots(
  input: CandidateRootInput,
): Promise<CandidatePlan> {
  const exists = input.exists ?? pathExists;
  const missing = resolve(input.missing);
  const home = resolve(input.home);
  const named = (input.readRoots ?? []).map((root) => resolve(root));
  const anchors = [missing, resolve(input.workingDir), ...named];
  const qualifies = (folder: string) =>
    anchors.some((anchor) => isInside(folder, anchor));

  const { searchable, guarded } = protectedFolders(input);
  const blocked = [...searchable, ...guarded].filter((dir) => !qualifies(dir));

  const roots: CandidateRoot[] = [
    { dir: resolve(input.workingDir), depth: WORKING_DEPTH },
    ...named.map((dir) => ({ dir, depth: NAMED_DEPTH })),
  ];
  const ancestor = await nearestExisting(dirname(missing), exists);
  if (ancestor !== null) {
    const parent = dirname(ancestor);
    roots.push(
      { dir: ancestor, depth: 2 },
      { dir: parent, depth: 1 },
      { dir: dirname(parent), depth: 1 },
    );
  }
  roots.push(
    ...searchable
      .filter((dir) => qualifies(dir))
      .map((dir) => ({ dir, depth: PROTECTED_DEPTH })),
  );
  return {
    roots: roots.filter(({ dir }) => dir !== home && !isFilesystemRoot(dir)),
    blocked,
  };
}

/** The deepest existing folder at or above `start`, or `null`. */
async function nearestExisting(
  start: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  let current = start;
  for (let i = 0; i < 64; i++) {
    if (await exists(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function isFilesystemRoot(dir: string): boolean {
  return parse(dir).root === dir;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
