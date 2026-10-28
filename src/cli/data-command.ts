import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { resolveStateDir } from "../config/index.js";
import { getAppVersion } from "../version.js";
import { backupStateDir, unpackBackup } from "./data-archive.js";

/**
 * ATO-579 — `atag data`: back up, restore, move and reset the state dir.
 * The folder is shared by the terminal and the desktop app, so every
 * command says so, and nothing is deleted: a restore or a reset moves the
 * old folder aside (`<stateDir>.before-restore-<time>`, `.reset-<time>`)
 * and prints where. Close every Atomic Agent window and terminal first;
 * the desktop app stops its own agent before it calls these.
 */
const HELP = [
  "Usage: atomic-agent data <command>",
  "",
  "The data folder holds chats, memory, tasks, settings and models. The terminal",
  "and the desktop app share it: everything here acts on both.",
  "",
  "Commands:",
  "  backup <file.tar.gz> [--with-models]  Archive the folder (models left out unless asked)",
  "  restore <file.tar.gz> --yes           Replace the folder with a backup; the current one is kept aside",
  "  move <new-folder>                     Move the folder (e.g. to another disk); the old path keeps working",
  "  reset --keep-models --yes             Start fresh but keep downloaded models; the rest is kept aside",
  "  path                                  Print where the folder is",
].join("\n");

export interface DataCommandDeps {
  stateDir?: string;
  write?: (text: string) => void;
  now?: () => Date;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Move a directory, across disks too (rename fails with EXDEV there). Across
 * disks the source is copied and then renamed aside on its own disk, never
 * deleted half way: returns where it was kept, or null after a plain rename.
 */
function moveDir(from: string, to: string, keptAs: string): string | null {
  try {
    renameSync(from, to);
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    renameSync(from, keptAs);
    return keptAs;
  }
}

export async function dataCommand(args: string[], deps: DataCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const now = (deps.now ?? (() => new Date()))();
  const stateDir = deps.stateDir ?? resolveStateDir();
  const [sub, ...rest] = args;
  const yes = rest.includes("--yes") || rest.includes("-y");
  const positional = rest.filter((a) => !a.startsWith("-"));

  if (!sub || sub === "-h" || sub === "--help") {
    write(`${HELP}\n`);
    return sub ? 0 : 2;
  }
  if (sub === "path") {
    write(`${stateDir}${existsSync(stateDir) && lstatSync(stateDir).isSymbolicLink() ? ` -> ${realpathSync(stateDir)}` : ""}\n`);
    return 0;
  }
  if (!existsSync(stateDir)) {
    write(`no data folder at ${stateDir}\n`);
    return 1;
  }
  const real = realpathSync(stateDir);

  if (sub === "backup") {
    const file = positional[0];
    if (!file) { write("data backup needs a file name, e.g. atomic-agent-backup.tar.gz\n"); return 2; }
    const r = await backupStateDir(real, file, { withModels: rest.includes("--with-models"), appVersion: getAppVersion(), now });
    write(`backed up ${r.files} files (${(r.bytes / 1024 ** 2).toFixed(1)} MB before compression) to ${r.file}\n`);
    write(`left out: ${r.skipped.join(", ")}. The archive holds your API keys: keep it private.\n`);
    return 0;
  }

  if (sub === "restore") {
    const file = positional[0];
    if (!file || !existsSync(file)) { write(`data restore needs an existing backup file${file ? `: ${file} not found` : ""}\n`); return 2; }
    if (!yes) { write("restore replaces the data folder the terminal and the desktop app share; run again with --yes\n"); return 2; }
    const incoming = `${real}.restore-${stamp(now)}`;
    let manifest: Record<string, unknown>;
    try {
      manifest = await unpackBackup(resolve(file), incoming);
    } catch (err) {
      rmSync(incoming, { recursive: true, force: true });
      write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    // The live folder goes aside first: if that fails nothing has changed yet.
    const aside = `${real}.before-restore-${stamp(now)}`;
    try {
      renameSync(real, aside);
    } catch (err) {
      rmSync(incoming, { recursive: true, force: true });
      write(`could not move ${real} aside (${(err as Error).message}); close every Atomic Agent window and terminal, then try again\n`);
      return 1;
    }
    try {
      // A backup without models keeps the models already downloaded here.
      if (!manifest.withModels && existsSync(join(aside, "models")) && !existsSync(join(incoming, "models"))) {
        renameSync(join(aside, "models"), join(incoming, "models"));
      }
      renameSync(incoming, real);
    } catch (err) {
      if (existsSync(join(incoming, "models")) && !existsSync(join(aside, "models"))) renameSync(join(incoming, "models"), join(aside, "models"));
      renameSync(aside, real);
      write(`restore failed (${(err as Error).message}); the data folder is as it was, the unpacked backup is at ${incoming}\n`);
      return 1;
    }
    write(`restored ${stateDir} from ${file}\nthe folder it replaced is at ${aside}; delete it once everything looks right\n`);
    return 0;
  }

  if (sub === "move") {
    const target = positional[0] ? resolve(positional[0]) : null;
    if (!target) { write("data move needs the new folder\n"); return 2; }
    if (target === real || target.startsWith(real + sep)) { write("the new folder cannot be inside the current one\n"); return 2; }
    if (existsSync(target) && readdirSync(target).length > 0) { write(`${target} is not empty; pick a new or empty folder\n`); return 2; }
    if (existsSync(target)) rmSync(target, { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    const kept = moveDir(real, target, `${real}.moved-${stamp(now)}`);
    // The old path stays the address both apps use: a link to the new place.
    if (existsSync(stateDir) || isDanglingLink(stateDir)) rmSync(stateDir, { force: true });
    symlinkSync(target, stateDir, process.platform === "win32" ? "junction" : "dir");
    write(`moved the data folder to ${target}\n${stateDir} now points there, so the terminal and the desktop app find it as before\n`);
    if (kept) write(`the copy on the old disk is at ${kept}; delete it once everything looks right\n`);
    return 0;
  }

  if (sub === "reset") {
    if (!rest.includes("--keep-models")) { write("data reset keeps downloaded models and needs --keep-models; to remove everything use `atag uninstall`\n"); return 2; }
    if (!yes) { write("reset clears chats, memory, tasks and settings for the terminal and the desktop app alike; run again with --yes\n"); return 2; }
    const aside = `${real}.reset-${stamp(now)}`;
    mkdirSync(aside, { mode: 0o700 });
    for (const name of readdirSync(real)) {
      if (name === "models") continue;
      renameSync(join(real, name), join(aside, name));
    }
    write(`reset ${stateDir}; models kept\nthe old chats, memory and settings are at ${aside}; delete it once you are sure\n`);
    return 0;
  }

  write(`unknown data command ${sub}\n\n${HELP}\n`);
  return 2;
}

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
