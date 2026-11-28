import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A run record per file trigger hit, shared by every process on one state
 * dir (ATO-2508). Around a leadership hand-over two processes can watch
 * the same file for a moment; both see one change and both would file a
 * task. Each asks `claim(key)` first, and only the process whose
 * exclusive create (`wx`, atomic on one filesystem) wins files it, the way
 * a cron runner claims a run before executing it.
 *
 * The key (`trigger|path|mtime|size`, from the watcher) is hashed into a
 * file name under `<stateDir>/file-trigger-claims/`. Records older than a
 * day are pruned, at most once an hour. Fails open like the scheduler
 * lock: if the folder cannot be written at all, every claim succeeds and
 * the trigger fires as it did before.
 */
export const FILE_TRIGGER_CLAIMS_DIR = "file-trigger-claims";

const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export interface FileTriggerClaims {
  /** `true` exactly once per key across processes (barring a write error). */
  claim(key: string): boolean;
}

export interface FileTriggerClaimsOptions {
  stateDir: string;
  /** Test seams. */
  now?: () => number;
  ttlMs?: number;
}

export function createFileTriggerClaims(options: FileTriggerClaimsOptions): FileTriggerClaims {
  const dir = join(options.stateDir, FILE_TRIGGER_CLAIMS_DIR);
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CLAIM_TTL_MS;
  let lastPrune = Number.NEGATIVE_INFINITY;

  const prune = (at: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const file = join(dir, name);
      try {
        if (at - statSync(file).mtimeMs > ttlMs) unlinkSync(file);
      } catch {
        // another process pruned it first
      }
    }
  };

  return {
    claim(key: string): boolean {
      const at = now();
      if (at - lastPrune >= PRUNE_EVERY_MS) {
        lastPrune = at;
        prune(at);
      }
      const file = join(dir, createHash("sha256").update(key).digest("hex").slice(0, 40));
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, String(at), { flag: "wx" });
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code !== "EEXIST";
      }
    },
  };
}
