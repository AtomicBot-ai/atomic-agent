import { isVoteKind, type VoteDirection, type VoteKind } from "./vote-store.js";

/**
 * Memory-v2 phase 7a. Parser for the `vote-runner` sub-call.
 *
 * Strict contract:
 *   - Empty body, the literal `NONE`, or whitespace-only ⇒
 *     `{ kind: "none" }`.
 *   - Otherwise each line must match either
 *       `UPVOTE   <kind>:<id>`
 *     or
 *       `DOWNVOTE <kind>:<id>`
 *     with `<kind> ∈ { memory | lesson | profile }` and `<id>` a
 *     positive integer. Bad lines are silently dropped — one
 *     malformed line never invalidates the whole batch.
 *   - The caller supplies a per-kind `allowlist` of legitimate ids
 *     (the surfaced set for this turn). Votes whose `(kind, id)`
 *     pair is not in the allowlist are dropped and counted in
 *     `rejected.notSurfaced`. This is the load-bearing
 *     anti-feedback-loop guard from MEMORY_FABRIC_V2.md §13.7.4
 *     invariant 18: the model cannot pump its own confidence by
 *     emitting votes against items it never saw in context.
 *   - Duplicate `(kind, id)` pairs within the same payload collapse
 *     to the first occurrence (winner-takes-all per call).
 *   - A hard cap of `maxVotes` (default 8 — matches the grammar)
 *     is applied after filtering so a runaway completion cannot
 *     pollute the audit log.
 */

export interface ParsedVote {
  kind: VoteKind;
  targetId: number;
  direction: VoteDirection;
}

export interface ParseRejection {
  /** Verbatim line from the model. */
  raw: string;
  reason: "malformed" | "not_surfaced" | "duplicate" | "cap_exceeded";
  /** Best-effort decoded `(kind, id)` when reason !== `malformed`. */
  kind?: VoteKind;
  targetId?: number;
}

export type ParsedVoteOutput =
  | { kind: "none" }
  | {
      kind: "votes";
      votes: ParsedVote[];
      rejected: ParseRejection[];
    };

/**
 * Surfaced allowlist per kind. The vote sub-call is the only path
 * that consults this — every other reflection sub-call (link,
 * evolve) operates on the memory id space alone.
 */
export interface VoteAllowlist {
  memory: ReadonlySet<number>;
  lesson: ReadonlySet<number>;
  profile: ReadonlySet<number>;
  procedure: ReadonlySet<number>;
}

export interface ParseVoteOptions {
  allowlist: VoteAllowlist;
  /** Hard cap on emitted votes after allowlist filtering. Default 8. */
  maxVotes?: number;
}

const VOTE_LINE_RE = /^(UPVOTE|DOWNVOTE)\s+([a-z]+):(\d+)\s*$/;

export function parseVoteOutput(
  raw: string,
  opts: ParseVoteOptions,
): ParsedVoteOutput {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "none" };
  if (/^NONE\s*$/i.test(trimmed)) return { kind: "none" };

  const max = opts.maxVotes ?? 8;
  const seen = new Set<string>();
  const votes: ParsedVote[] = [];
  const rejected: ParseRejection[] = [];

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = VOTE_LINE_RE.exec(line);
    if (!match) {
      rejected.push({ raw: line, reason: "malformed" });
      continue;
    }
    const verb = match[1] as "UPVOTE" | "DOWNVOTE";
    const rawKind = match[2] ?? "";
    const targetId = Number(match[3]);
    if (!isVoteKind(rawKind)) {
      rejected.push({ raw: line, reason: "malformed" });
      continue;
    }
    if (!Number.isInteger(targetId) || targetId <= 0) {
      rejected.push({ raw: line, reason: "malformed" });
      continue;
    }
    const kind = rawKind;
    if (!opts.allowlist[kind].has(targetId)) {
      rejected.push({
        raw: line,
        reason: "not_surfaced",
        kind,
        targetId,
      });
      continue;
    }
    const dedupKey = `${kind}:${targetId}`;
    if (seen.has(dedupKey)) {
      rejected.push({
        raw: line,
        reason: "duplicate",
        kind,
        targetId,
      });
      continue;
    }
    if (votes.length >= max) {
      rejected.push({
        raw: line,
        reason: "cap_exceeded",
        kind,
        targetId,
      });
      continue;
    }
    seen.add(dedupKey);
    votes.push({
      kind,
      targetId,
      direction: verb === "UPVOTE" ? 1 : -1,
    });
  }

  if (votes.length === 0 && rejected.length === 0) return { kind: "none" };
  return { kind: "votes", votes, rejected };
}
