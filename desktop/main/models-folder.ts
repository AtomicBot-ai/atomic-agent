/**
 * ATO-2106: the folder downloaded models live in, and the words around
 * moving it (LM Studio's My Models › Models Directory › Change).
 *
 * The agent owns the choice: `localModels.managed.modelsDirOverride` in
 * config.json, written by `atag models dir <folder>` after it has moved
 * every model there (src/cli/models-dir-command.ts). Without the key the
 * models stay in `<data dir>/models`. This file reads the key the same way
 * the agent does (`~` is the home folder), so every desktop path that names
 * a model folder (disk-space.ts modelsDirOf) follows the move.
 *
 * Pure but for one file read: no Electron import, so the unit suite can
 * load it from `out/main` (test/models-folder.test.mjs).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { DESKTOP_STATE_DIR } from "./state-dir.js";

/** The override a config.json text names, as an absolute path, or null. */
export function modelsDirOverrideIn(configText: string, home: string = homedir()): string | null {
  let raw: unknown;
  try {
    raw = (JSON.parse(configText) as { localModels?: { managed?: { modelsDirOverride?: unknown } } })
      ?.localModels?.managed?.modelsDirOverride;
  } catch {
    return null;
  }
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return resolve(home, value.slice(2));
  return resolve(value);
}

/** The override in the desktop's config.json right now, or null. */
export function modelsDirOverrideNow(stateDir: string = DESKTOP_STATE_DIR): string | null {
  try {
    return modelsDirOverrideIn(readFileSync(join(stateDir, "config.json"), "utf8"));
  } catch {
    return null;
  }
}

/** What the Models pane shows: `atag models dir --json`. */
export interface ModelsFolderInfo {
  dir: string;
  defaultDir: string;
  custom: boolean;
}

export function parseModelsFolderInfo(stdout: string): ModelsFolderInfo | null {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const v = JSON.parse(text) as Partial<ModelsFolderInfo>;
      if (typeof v.dir === "string" && v.dir && typeof v.defaultDir === "string") {
        return { dir: v.dir, defaultDir: v.defaultDir, custom: v.custom === true };
      }
    } catch {
      /* not this line */
    }
  }
  return null;
}

/** One `moving <model> (2/5)` line of `atag models dir <folder>`. */
export interface ModelsMoveProgress {
  entry: string;
  index: number;
  total: number;
}

export function parseModelsMoveLine(line: string): ModelsMoveProgress | null {
  const m = /^moving (.+) \((\d+)\/(\d+)\)\s*$/.exec(line.trim());
  if (!m) return null;
  const index = Number(m[2]);
  const total = Number(m[3]);
  return index >= 1 && total >= index ? { entry: m[1]!, index, total } : null;
}

/** `models folder: <path>`, the last line of a move that worked. */
export function movedToFromStdout(stdout: string): string | null {
  const m = /^models folder: (.+)$/m.exec(stdout);
  return m ? m[1]!.trim() : null;
}

/** Old copies the agent could not delete after a move across disks. */
export function leftoversFromStdout(stdout: string): string[] {
  return [...stdout.matchAll(/^could not delete the old copy at (.+); delete it by hand$/gm)].map((m) => m[1]!.trim());
}

/**
 * The agent's refusal in words for the pane. Its line is `models dir: <why>`;
 * an agent without the subcommand says `unknown subcommand: dir`.
 */
/** Said when the picked folder already holds something (the agent refuses it too). */
export const NOT_EMPTY_WORDS = "That folder is not empty. Pick an empty folder, or make a new one with New Folder.";

/** True when a folder listing counts as empty: nothing, or only `.DS_Store`. */
export function folderListingIsEmpty(names: readonly string[]): boolean {
  return names.every((n) => n === ".DS_Store");
}

export function moveErrorWords(stderr: string, code: number | null): string {
  if (/is not empty/.test(stderr)) return NOT_EMPTY_WORDS;
  if (/unknown subcommand: dir\b/.test(stderr)) {
    return "This version of the agent cannot move models yet. Update the agent, then try again.";
  }
  if (/a local model is running/.test(stderr)) {
    return "Stop the local model first (Stop, above), then move the models.";
  }
  if (/a model download is running/.test(stderr)) {
    return "Wait for the model download to finish, or pause it, then move the models.";
  }
  const said = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  if (said) return said.replace(/^models dir: /, "").replace(/^./, (c) => c.toUpperCase());
  return `The models were not moved (exit code ${code ?? "none"}).`;
}
