/**
 * ATO-321. Recall-time name check for notes and lessons.
 *
 * `name-grounding.ts` keeps a profile name nobody typed out of the
 * prompt, but a note or lesson that says the same thing ("I am Alex",
 * "The user is Alex", "Пользователь Анна") still reached `### recalled`,
 * `### memory-index` and `### lessons`. Field case: notes left by old QA
 * runs on one machine, for a user who never wrote "Alex".
 *
 * This guard applies the same rule to those surfaces: a row that claims
 * a name for the user stays out of the prompt unless some stored user
 * message carries that name. Rows are never changed or deleted; they
 * stay readable by id (`memory.notes.recall { id }`) and in the memory
 * view.
 *
 *   - Verdicts are cached in memory per name (lower-cased) for the life
 *     of the process. A restart re-checks, so a name the user gives
 *     later is picked up then.
 *   - `grounded` and `unverifiable` (another script, nothing to compare)
 *     let the row through — the same "a name we cannot compare fails
 *     open" rule as reflection.
 *   - A name not checked yet holds the row out and starts a background
 *     check (one per name), so the next turn has the verdict. The boot
 *     `prefetch` checks the names in recent notes and active lessons
 *     before the first turn usually needs them.
 *   - A check that throws holds the row out for this process, like the
 *     profile check does.
 *
 * Rows that claim no name — nearly all of them — cost one regex pass.
 * Logs carry counts only, never names.
 */

import type { StructuredLogger } from "../tracing/structured-logger.js";

import {
  nameGroundingAcrossSessions,
  type GroundingConversationSource,
} from "./name-grounding.js";
import type { NameGroundingStatus } from "./profile-name-keys.js";
import { claimedUserNames } from "./reflection/reflection-grounding.js";

type Verdict = NameGroundingStatus | "failed";

export interface RecallNameGuard {
  /** Whether a row with this text may be rendered into the prompt. */
  allows(text: string): boolean;
}

export interface RecallNameGuardHandle extends RecallNameGuard {
  /** Check every name these texts claim. Resolves when all are known. */
  prefetch(texts: Iterable<string>): Promise<RecallNamePrefetchReport>;
}

export interface RecallNamePrefetchReport {
  names: number;
  grounded: number;
  ungrounded: number;
  unverifiable: number;
  failed: number;
}

export function createRecallNameGuard(args: {
  source: GroundingConversationSource;
  logger?: StructuredLogger;
}): RecallNameGuardHandle {
  const verdicts = new Map<string, Verdict>();
  const inFlight = new Map<string, Promise<Verdict>>();

  const check = (name: string): Promise<Verdict> => {
    const key = name.toLowerCase();
    const known = verdicts.get(key);
    if (known !== undefined) return Promise.resolve(known);
    const running = inFlight.get(key);
    if (running) return running;
    const started = nameGroundingAcrossSessions(name, args.source)
      .then(
        (verdict): Verdict => verdict,
        (err: unknown): Verdict => {
          args.logger?.warn("recall name check failed; the row stays out of the prompt", {
            error: err instanceof Error ? err.message : String(err),
          });
          return "failed";
        },
      )
      .then((verdict) => {
        verdicts.set(key, verdict);
        inFlight.delete(key);
        return verdict;
      });
    inFlight.set(key, started);
    return started;
  };

  return {
    allows(text) {
      const names = claimedUserNames(text);
      if (names.length === 0) return true;
      let allowed = true;
      for (const name of names) {
        const verdict = verdicts.get(name.toLowerCase());
        if (verdict === "grounded" || verdict === "unverifiable") continue;
        allowed = false;
        // Not checked yet: start the check, hold the row out this turn.
        if (verdict === undefined) void check(name);
      }
      return allowed;
    },
    async prefetch(texts) {
      const names = new Map<string, string>();
      for (const text of texts) {
        for (const name of claimedUserNames(text)) {
          names.set(name.toLowerCase(), name);
        }
      }
      const report: RecallNamePrefetchReport = {
        names: names.size,
        grounded: 0,
        ungrounded: 0,
        unverifiable: 0,
        failed: 0,
      };
      for (const name of names.values()) {
        report[await check(name)] += 1;
      }
      if (report.names > 0) {
        args.logger?.info("note and lesson names checked against the user's messages", {
          names: report.names,
          grounded: report.grounded,
          ungrounded: report.ungrounded,
          unverifiable: report.unverifiable,
          failed: report.failed,
        });
      }
      return report;
    },
  };
}
