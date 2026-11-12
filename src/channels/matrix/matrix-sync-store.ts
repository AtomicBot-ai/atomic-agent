/**
 * Where the Matrix channel left off: the last `/sync` `next_batch`,
 * stored at `<stateDir>/matrix-sync.json` so a restart resumes from
 * there instead of replaying the room history as fresh requests.
 *
 * Keyed by the bot's user id: pointing the channel at another account
 * (or another homeserver) must not resume with a token from the old
 * one, which the server would reject or, worse, accept for a stream
 * that is not ours.
 *
 * Same robustness contract as the session map: a corrupt file reads
 * as "nothing stored" (the channel then does a fresh initial sync and
 * skips old events), writes are atomic (tmp + rename).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface StoredSync {
  userId: string;
  nextBatch: string;
}

export class MatrixSyncStore {
  constructor(private readonly path: string) {}

  /** The stored token for `userId`, or `null` (first run, other account, bad file). */
  load(userId: string): string | null {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredSync>;
      if (parsed.userId !== userId) return null;
      return typeof parsed.nextBatch === "string" && parsed.nextBatch.length > 0
        ? parsed.nextBatch
        : null;
    } catch {
      return null;
    }
  }

  save(userId: string, nextBatch: string): void {
    const data: StoredSync = { userId, nextBatch };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
