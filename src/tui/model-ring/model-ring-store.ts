import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  cleanModelRing,
  formatModelRingEntry,
  type ModelRingEntry,
  type ModelRingState,
} from "./model-ring.js";

/**
 * The favourite-model ring (ATO-2169) lives in the state dir, not the
 * config: a display shortlist the agent never reads, so it carries no
 * schema version and a missing or broken file is simply an empty ring.
 * Same shape of file as model-spotlight-seen.json.
 *
 * ATO-2500: one list for both apps. The desktop runs on the same state
 * dir (`~/.atomic-agent`) and its model picker's Favorites group reads
 * and writes this file through its main process
 * (desktop/main/model-favorites-store.ts), in this format: `{"models":
 * ["provider/model", ...]}`, oldest first, at most MODEL_RING_MAX. Each
 * side reads the file again before it changes it, so a star set in one
 * app is not lost to a write from the other.
 */
export const MODEL_RING_FILE = "model-favorites.json";

export function readModelRing(stateDir: string): ModelRingEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(stateDir, MODEL_RING_FILE), "utf8"));
    return cleanModelRing((parsed as { models?: unknown } | null)?.models);
  } catch {
    // Missing until the first favourite; a corrupt file reads as none.
    return [];
  }
}

/** Writes the whole ring (temp file, then rename). False when it could not be saved. */
export function writeModelRing(stateDir: string, ring: readonly ModelRingEntry[]): boolean {
  const path = join(stateDir, MODEL_RING_FILE);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ models: ring.map(formatModelRingEntry) }, null, 2)}\n`);
    renameSync(tmp, path);
    return true;
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
}

/**
 * The ring the TUI starts with (ATO-2500): the `--models` list for this
 * session when one was given, else the shared file.
 */
export function startupModelRing(sessionRing: readonly ModelRingEntry[] | null, stateDir: string): ModelRingState {
  return sessionRing
    ? { entries: [...sessionRing], sessionOnly: true }
    : { entries: readModelRing(stateDir), sessionOnly: false };
}
