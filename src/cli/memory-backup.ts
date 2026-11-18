import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { getConfig } from "../config/index.js";
import { snapshotSqlite } from "../import/atomic-desktop/index.js";

/**
 * `atomic-agent memory backup [--out <dir>]` (ATO-46, "export and
 * import memory whole"): one consistent copy of everything the agent
 * remembers (notes, profile facts with their history, lessons,
 * procedures, links, embeddings), taken while the agent may be running.
 *
 * The copy is `<dir>/memory.sqlite`, the same file name a data folder
 * uses. The restore it points to is the import that already exists:
 * `atomic-agent import atomic-agent --source <dir> --include memory
 * --exclude sessions,skills,mcp,providers --yes`. That import brings back
 * notes and profile facts only, merged into the current memory (anything
 * already here is kept). Lessons, procedures, votes and note links stay in
 * the file but are not imported (ATOMIC_DESKTOP_NOT_IMPORTED); the agent
 * forms them again from the notes. RESTORE.txt and the help say so.
 *
 * Read-only on the live database (sqlite-snapshot.ts). Refuses a folder
 * that already holds a backup, so a second run cannot overwrite one.
 */
export const MEMORY_BACKUP_FILE = "memory.sqlite";

/** What RESTORE.txt says; exported so the test pins the honest wording. */
export function restoreNoteFor(dir: string): string {
  return [
    "Atomic Agent memory backup.",
    "",
    "memory.sqlite here is a full copy of the memory: notes, profile facts with their history,",
    "lessons, procedures, votes and note links.",
    "",
    "To bring back the notes and profile facts (merged into the current memory, nothing already",
    "there is replaced):",
    "",
    `  ${restoreCommandFor(dir)}`,
    "",
    "This import does not bring back lessons, procedures, votes or note links. The agent forms",
    "them again from the notes over time.",
    "",
  ].join("\n");
}

export function defaultBackupDir(stateDir: string, now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return join(stateDir, "backups", `memory-${stamp}`);
}

export function restoreCommandFor(dir: string): string {
  return `atomic-agent import atomic-agent --source ${JSON.stringify(dir)} --include memory --exclude sessions,skills,mcp,providers --yes`;
}

export interface MemoryBackupDeps {
  memoryDbFile: string;
  stateDir: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
  now?: Date;
}

/** Exit 0 on success, 1 on failure, 2 on a usage error. */
export async function runMemoryBackup(outArg: string | undefined, deps: MemoryBackupDeps): Promise<number> {
  const out = deps.out ?? ((t: string) => void process.stdout.write(t));
  const err = deps.err ?? ((t: string) => void process.stderr.write(t));
  if (!existsSync(deps.memoryDbFile)) {
    err(`no memory yet: ${deps.memoryDbFile} does not exist\n`);
    return 1;
  }
  const dir = resolve(outArg ?? defaultBackupDir(deps.stateDir, deps.now));
  const dest = join(dir, MEMORY_BACKUP_FILE);
  if (existsSync(dest)) {
    err(`${dest} already exists; pick another --out folder\n`);
    return 2;
  }
  try {
    mkdirSync(dir, { recursive: true });
    await snapshotSqlite(deps.memoryDbFile, dest);
    writeFileSync(
      join(dir, "RESTORE.txt"),
      restoreNoteFor(dir),
      "utf8",
    );
  } catch (e) {
    err(`memory backup failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  out(`memory backed up -> ${dest}\nrestore notes and profile facts with:\n  ${restoreCommandFor(dir)}\n(lessons, procedures and links are not imported; see RESTORE.txt)\n`);
  return 0;
}

export async function handleBackup(args: string[], readOption: (args: string[], name: string) => string | undefined): Promise<number> {
  const config = getConfig();
  return runMemoryBackup(readOption(args, "--out"), {
    memoryDbFile: config.paths.memoryDbFile,
    stateDir: config.paths.stateDir,
  });
}
