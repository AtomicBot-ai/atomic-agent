import { parsePositiveInt, parseBool } from "./config-primitives.js";

export interface RuntimeSessionsConfig {
  retention: {
    /**
     * Master switch, default `false`. A session is the transcript of
     * the operator's own work, so nothing deletes one until they ask:
     * with this off the prune does not even open the table.
     */
    enabled: boolean;
    /**
     * Prune sessions whose `updated_at` is older than this; `null` is
     * no age rule.
     */
    maxAgeDays: number | null;
    /** Keep at most this many sessions, oldest first; `null` is no cap. */
    maxRows: number | null;
  };
}

export interface UserSessionsConfig {
  retention: {
    /** Default `false`: the operator opts in. */
    enabled: boolean;
    /**
     * Age cutoff in days against `updated_at`. Default 90. A positive
     * integer, or `null` for no age rule (leaving `maxRows` as the
     * only thing that prunes). Note that `undefined` takes the
     * default and an explicit `null` does not — clearing the rule is
     * a choice, not an omission.
     */
    maxAgeDays: number | null;
    /**
     * Hard cap on stored sessions; anything past it goes oldest
     * first. Default `null` (no cap) — a row count means nothing
     * without knowing how the operator works, so age is the rule that
     * ships on.
     */
    maxRows: number | null;
  };
}

/**
 * Parse an optional cap: a positive integer, or `null` for "no limit".
 *
 * Takes its own fallback rather than reading `raw ?? default` at the call
 * site, because the two absences are not the same thing when the default
 * is a number: a missing key means "you decide" and must land on
 * `fallback`, while an explicit `null` is the operator switching the rule
 * off and `??` would quietly put the default back.
 */
function parseCapOrNull(
  raw: unknown,
  field: string,
  fallback: number | null,
): number | null {
  if (raw === undefined) return fallback;
  if (raw === null) return null;
  return parsePositiveInt(raw, field);
}

export function createSessionDefaults(): UserSessionsConfig {
  return {
    retention: {
      // Off. Deleting an operator's transcripts is not a default.
      enabled: false,
      // A quarter: long enough that "what did I do on that project?"
      // still has an answer, short enough that an install left running
      // for a year is not carrying every session it ever had.
      maxAgeDays: 90,
      // No cap. Age is a statement about what is still interesting; a
      // row count is a statement about disk, and only the operator
      // knows whether theirs is the problem.
      maxRows: null,
    },
  };
}

export function parseSessionConfig(
  sessionsRetention: Record<string, unknown>,
  readDefaults: () => UserSessionsConfig,
): UserSessionsConfig {
  return {
    retention: {
      enabled: parseBool(
        sessionsRetention.enabled ??
          readDefaults().retention.enabled,
        "sessions.retention.enabled",
      ),
      maxAgeDays: parseCapOrNull(
        sessionsRetention.maxAgeDays,
        "sessions.retention.maxAgeDays",
        readDefaults().retention.maxAgeDays,
      ),
      maxRows: parseCapOrNull(
        sessionsRetention.maxRows,
        "sessions.retention.maxRows",
        readDefaults().retention.maxRows,
      ),
    },
  };
}
