import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  cleanModelRing,
  formatModelRingEntry,
  type ModelRingEntry,
} from "./model-ring.js";

/**
 * The favourite-model ring (ATO-2169) lives in the state dir, not the
 * config: it is a terminal display shortlist that nothing else reads, so
 * it carries no schema version and a missing or broken file is simply an
 * empty ring. Same shape of file as model-spotlight-seen.json.
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
