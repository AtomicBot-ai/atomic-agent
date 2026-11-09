import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  isModelDownloaded,
  LOCAL_MODELS_CATALOG,
  spotlightModelFor,
  type LocalModelDef,
} from "../../local-llm/index.js";
import { hostRamGb } from "../onboarding/local-model-picks.js";

/** Model ids the hint has been shown for; lives in the state dir, not the config. */
const SEEN_FILE = "model-spotlight-seen.json";

export interface ModelSpotlightHintInput {
  stateDir: string;
  dataDir: string;
  /** First-run setup is open or still due: no hint, and nothing recorded. */
  firstRun: boolean;
  /** Defaults to the curated catalog. */
  catalog?: readonly LocalModelDef[];
  /** Defaults to this machine's memory. */
  memoryGb?: number;
  /** Defaults to the weights being on disk under `dataDir`. */
  isDownloaded?: (def: LocalModelDef) => boolean;
}

export function formatModelSpotlightHint(def: LocalModelDef): string {
  return `New model: ${def.name}, ${def.sizeLabel}. Run /model pull ${def.id} to download and start it, or /local to see all local models.`;
}

/**
 * The startup line for a model launch, or null when there is nothing to
 * say. Returning a line records it as shown, so it appears at most once
 * per model id; if that cannot be recorded the line is held back, since
 * a hint repeated on every launch is worse than none.
 */
export function takeModelSpotlightHint(input: ModelSpotlightHintInput): string | null {
  if (input.firstRun) return null;
  const def = spotlightModelFor(
    input.catalog ?? LOCAL_MODELS_CATALOG,
    input.memoryGb ?? hostRamGb(),
    input.isDownloaded ?? ((m) => isModelDownloaded(input.dataDir, m)),
  );
  if (def === null) return null;
  const seen = readSeen(input.stateDir);
  if (seen.includes(def.id)) return null;
  if (!writeSeen(input.stateDir, [...seen, def.id])) return null;
  return formatModelSpotlightHint(def);
}

function readSeen(stateDir: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(stateDir, SEEN_FILE), "utf8"));
    const ids = (parsed as { seen?: unknown } | null)?.seen;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    // Missing until the first hint; a corrupt file costs one repeat at most.
    return [];
  }
}

function writeSeen(stateDir: string, seen: readonly string[]): boolean {
  const path = join(stateDir, SEEN_FILE);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ seen })}\n`);
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing was written, or nothing can be removed.
    }
    return false;
  }
}
