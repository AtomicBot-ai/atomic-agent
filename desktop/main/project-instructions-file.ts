import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/**
 * ATO-1012 (ATO-56, the desktop's half): which instruction file a project's
 * folder carries, for the Edit project sheet's "Also follows AGENTS.md in
 * this folder · Open" line. The agent itself reads these files (after the
 * folder is trusted, src/runtime/project-instructions.ts); this only names
 * the file and shows its first lines, so the person sees that the project
 * follows more than the text typed in the sheet.
 *
 * The names and their order are the agent's (`rootNames` in
 * src/runtime/project-instruction-files.ts); keep the two lists alike.
 *
 * A file that is a link pointing outside the folder is treated as absent:
 * the sheet never reads or opens anything outside the project's folder.
 */
export const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "AGENT.md", "CLAUDE.md", ".claude/CLAUDE.md"] as const;

/** How much of the file the sheet gets: enough for its first lines. */
export const INSTRUCTIONS_HEAD_BYTES = 2048;

export interface InstructionsFile {
  /** The file's real path (links resolved), or where AGENTS.md would go when there is none. */
  path: string;
  /** Its name as the agent knows it, e.g. "AGENTS.md" or ".claude/CLAUDE.md". */
  name: string;
  exists: boolean;
  /** The first INSTRUCTIONS_HEAD_BYTES of the file as text; "" when there is none. */
  head: string;
  /** The other names in this folder the agent also reads, in its order. */
  also: string[];
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The file's real path when it is a regular file inside `realRoot`, else null. */
function realFileInside(realRoot: string, candidate: string): string | null {
  let real: string;
  try { real = realpathSync(candidate); } catch { return null; }
  if (!inside(realRoot, real)) return null;
  try { return statSync(real).isFile() ? real : null; } catch { return null; }
}

/** The first `max` bytes as text, a character cut in half at the end dropped. */
function readHead(path: string, max: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString("utf8").replace(/\uFFFD+$/, "");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * The first of the agent's instruction files that `folder` has, or a
 * not-there answer naming AGENTS.md. Null when `folder` is not an absolute
 * path to a folder on this computer. Never throws.
 */
export function instructionsFileFor(folder: unknown): InstructionsFile | null {
  if (typeof folder !== "string" || !folder || folder.length > 4096 || !isAbsolute(folder)) return null;
  let realRoot: string;
  try {
    realRoot = realpathSync(folder);
    if (!statSync(realRoot).isDirectory()) return null;
  } catch {
    return null;
  }
  const found: { name: string; real: string }[] = [];
  for (const name of INSTRUCTION_FILE_NAMES) {
    const real = realFileInside(realRoot, join(realRoot, name));
    if (real) found.push({ name, real });
  }
  const first = found[0];
  if (!first) return { path: join(realRoot, "AGENTS.md"), name: "AGENTS.md", exists: false, head: "", also: [] };
  return {
    path: first.real,
    name: first.name,
    exists: true,
    head: readHead(first.real, INSTRUCTIONS_HEAD_BYTES),
    also: found.slice(1).map((f) => f.name),
  };
}
