/**
 * The tracker's call history and the two walks over it. Pure: the
 * `ToolLoopTracker` owns the array; these only read it.
 */

export interface HistoryEntry {
  tool: string;
  argsHash: string;
  /** Set by `recordOutcome`. `undefined` while pending or when vetoed. */
  resultHash?: string;
  /** True when the outcome was a loop veto (excluded from the streak). */
  vetoed?: boolean;
  /** Step round the call was dispatched in (see `noteStep`). */
  round?: number;
  /**
   * What the call is judged against (see `ToolLoopTracker.callEpoch`).
   * For an `os.fs.read`, the mutation epoch of its path at dispatch
   * (`MutationEpochs`). For any other call except a write or a
   * deliberate poll, how many writes had landed this turn. `undefined`
   * for writes, polls and batches.
   */
  epoch?: number;
  /**
   * Deliberate polls run this turn before the call was dispatched; set
   * on every call that carries an `epoch`. A poll lets time pass on
   * purpose, so the same read of a log or the same status command after
   * it is a new question.
   */
  polls?: number;
}

/** The two clocks a call is judged on; see `HistoryEntry`. */
export interface CallEpoch {
  epoch?: number;
  polls?: number;
}

function sameEpoch(record: HistoryEntry, at: CallEpoch): boolean {
  return record.epoch === at.epoch && record.polls === at.polls;
}

/**
 * Walk history backwards counting identical `(tool, argsHash)` entries
 * whose `resultHash` matches the most recent matching result. Non-
 * matching tools are skipped (`continue`) so interleaving is tolerated;
 * a changed `resultHash` breaks the streak (`break`) so progress clears
 * it; entries without a `resultHash` (pending or vetoed) are skipped.
 * Only entries of the same epochs count: a write that landed (or a
 * poll that let time pass) between two identical calls makes the later
 * one a new question.
 */
export function getNoProgressStreak(
  history: readonly HistoryEntry[],
  tool: string,
  argsHash: string,
  at: CallEpoch = {},
): { count: number; latestResultHash?: string } {
  let streak = 0;
  let latestResultHash: string | undefined;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i]!;
    if (record.tool !== tool || record.argsHash !== argsHash) continue;
    if (!sameEpoch(record, at)) continue;
    if (typeof record.resultHash !== "string" || !record.resultHash) continue;
    if (latestResultHash === undefined) {
      latestResultHash = record.resultHash;
      streak = 1;
      continue;
    }
    if (record.resultHash !== latestResultHash) break;
    streak += 1;
  }
  return latestResultHash === undefined
    ? { count: streak }
    : { count: streak, latestResultHash };
}

/**
 * Raw count of matching `(tool, argsHash)` entries in the window, of the
 * same epochs only (writes, polls and batches carry none, so they match
 * each other as before).
 */
export function getRepeatCount(
  history: readonly HistoryEntry[],
  tool: string,
  argsHash: string,
  at: CallEpoch = {},
): number {
  let count = 0;
  for (const record of history) {
    if (record.tool !== tool || record.argsHash !== argsHash) continue;
    if (sameEpoch(record, at)) count += 1;
  }
  return count;
}

/**
 * A bounded ring of recent keys that answers "how many times has this
 * key come up in the last `capacity` entries?". Memory is fixed by
 * construction, so a turn that runs for thousands of steps holds the
 * same few dozen keys as one that ran for ten.
 */
export class RecentKeys {
  private readonly ring: string[] = [];
  constructor(private readonly capacity: number) {}

  /** Add `key` and return how many times it is in the window now. */
  push(key: string): number {
    this.ring.push(key);
    if (this.ring.length > this.capacity) this.ring.shift();
    let count = 0;
    for (const entry of this.ring) if (entry === key) count += 1;
    return count;
  }

  clear(): void {
    this.ring.length = 0;
  }

  get size(): number {
    return this.ring.length;
  }
}
