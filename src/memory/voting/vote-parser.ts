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

  // Cloud providers driven by Structured Outputs (see
  // `VOTE_RESPONSE_FORMAT`) emit JSON instead of the legacy text
  // grammar. Try the JSON shape first when the body looks like JSON
  // — on success we use those votes; on failure we fall through to
  // the line-based grammar parser so the local llama path stays
  // byte-identical.
  if (trimmed.startsWith("{")) {
    const fromJson = parseVoteJsonShape(trimmed, opts);
    if (fromJson) return fromJson;
  }

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

/**
 * Parse the Structured Outputs JSON shape:
 *
 *   { "kind": "none" }
 *   { "kind": "votes",
 *     "votes": [
 *       { target_kind, target_id, direction }, ...
 *     ] }
 *
 * Returns `null` on any structural / type mismatch so the caller can
 * fall back to the legacy text-grammar parser. The same allowlist /
 * dedup / cap invariants apply as the line path — Structured Outputs
 * catches schema mismatches server-side but never proves semantic
 * legitimacy.
 */
function parseVoteJsonShape(
  raw: string,
  opts: ParseVoteOptions,
): ParsedVoteOutput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const kindField = obj["kind"];
  if (kindField === "none") return { kind: "none" };
  if (kindField !== "votes") return null;
  const votesField = obj["votes"];
  if (!Array.isArray(votesField)) return null;

  const max = opts.maxVotes ?? 8;
  const seen = new Set<string>();
  const votes: ParsedVote[] = [];
  const rejected: ParseRejection[] = [];

  for (const entry of votesField) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      rejected.push({ raw: JSON.stringify(entry), reason: "malformed" });
      continue;
    }
    const rec = entry as Record<string, unknown>;
    const rawKind =
      typeof rec["target_kind"] === "string" ? rec["target_kind"] : "";
    const targetId =
      typeof rec["target_id"] === "number" &&
      Number.isInteger(rec["target_id"]) &&
      (rec["target_id"] as number) > 0
        ? (rec["target_id"] as number)
        : NaN;
    const directionRaw = rec["direction"];
    const direction: VoteDirection | null =
      directionRaw === 1 ? 1 : directionRaw === -1 ? -1 : null;
    const rawJson = JSON.stringify(entry);
    if (!isVoteKind(rawKind) || !Number.isInteger(targetId) || direction === null) {
      rejected.push({ raw: rawJson, reason: "malformed" });
      continue;
    }
    const kind = rawKind;
    if (!opts.allowlist[kind].has(targetId)) {
      rejected.push({
        raw: rawJson,
        reason: "not_surfaced",
        kind,
        targetId,
      });
      continue;
    }
    const dedupKey = `${kind}:${targetId}`;
    if (seen.has(dedupKey)) {
      rejected.push({
        raw: rawJson,
        reason: "duplicate",
        kind,
        targetId,
      });
      continue;
    }
    if (votes.length >= max) {
      rejected.push({
        raw: rawJson,
        reason: "cap_exceeded",
        kind,
        targetId,
      });
      continue;
    }
    seen.add(dedupKey);
    votes.push({ kind, targetId, direction });
  }

  if (votes.length === 0 && rejected.length === 0) return { kind: "none" };
  return { kind: "votes", votes, rejected };
}
