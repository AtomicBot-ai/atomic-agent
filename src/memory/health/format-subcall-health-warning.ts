import type {
  MemorySubcallKind,
  UnhealthySubcallOutcome,
} from "./track-subcall-health.js";

/** Longest failure reason quoted in a warning; the log keeps the rest. */
export const MEMORY_HEALTH_REASON_MAX_CHARS = 120;

interface SubcallCopy {
  /** What the sentence calls the sub-call. */
  label: string;
  /** What stops working while the sub-call keeps failing. */
  consequence: string;
  /** The config key that bounds one call. */
  timeoutSetting: string;
  /** Added after the timeout key when it is not the sub-call's own. */
  timeoutNote?: string;
  /** The config switch that turns the sub-call off. */
  disableSetting: string;
}

const COPY: Readonly<Record<MemorySubcallKind, SubcallCopy>> = {
  reflection: {
    label: "Memory reflection",
    consequence: "nothing new is being remembered",
    timeoutSetting: "memory.reflection.timeoutMs",
    disableSetting: "memory.reflection.enabled",
  },
  link_generator: {
    label: "Memory link generation",
    consequence: "the memory graph stays empty and no lessons get distilled",
    timeoutSetting: "memory.links.generatorTimeoutMs",
    disableSetting: "memory.links.autoGenerate",
  },
  vote: {
    label: "Memory voting",
    consequence: "recalled memories are not being scored",
    // Bootstrap builds the vote runner with the reflection timeout.
    timeoutSetting: "memory.reflection.timeoutMs",
    timeoutNote: " (voting shares it)",
    disableSetting: "memory.voting.enabled",
  },
  rewriter: {
    label: "The memory query rewriter",
    consequence: "follow-up questions are recalled by their literal wording",
    timeoutSetting: "memory.retrieve.rewriter.timeoutMs",
    disableSetting: "memory.retrieve.rewriter.enabled",
  },
};

/**
 * The config key a warning names: the per-call timeout when calls time
 * out, the sub-call's own switch when they fail outright — a longer
 * timeout does not fix a provider that refuses the request.
 */
export function selectSubcallHealthSetting(
  kind: MemorySubcallKind,
  outcome: UnhealthySubcallOutcome,
): string {
  const copy = COPY[kind];
  return outcome === "timeout" ? copy.timeoutSetting : copy.disableSetting;
}

/**
 * The operator-facing notice for a sub-call that keeps timing out or
 * failing. Two lines: what stopped working, then the setting to change.
 *
 * Memory sub-calls run after the reply, fire-and-forget, so a failure
 * leaves nothing in the chat — the agent simply stops learning. No
 * default values are quoted: those move, and a notice naming a stale
 * default is worse than one naming none.
 */
export function formatSubcallHealthWarning(args: {
  kind: MemorySubcallKind;
  outcome: UnhealthySubcallOutcome;
  consecutive: number;
  reason?: string;
}): string {
  const copy = COPY[args.kind];
  if (args.outcome === "timeout") {
    return [
      `${copy.label} timed out ${args.consecutive} times in a row, so ${copy.consequence}.`,
      `Raise ${copy.timeoutSetting}${copy.timeoutNote ?? ""} — hosted reasoning models often need tens of seconds.`,
    ].join("\n");
  }
  const reason =
    args.reason !== undefined ? summarizeFailureReason(args.reason) : "";
  return [
    `${copy.label} failed ${args.consecutive} times in a row${
      reason.length > 0 ? ` (${reason})` : ""
    }, so ${copy.consequence}.`,
    `If this model cannot run it, set ${copy.disableSetting} to false.`,
  ].join("\n");
}

const SECRET_SHAPES: readonly (readonly [RegExp, string])[] = [
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "<key>"],
  [/(\bbearer\s+)[A-Za-z0-9+/=._-]{16,}/gi, "$1<redacted>"],
  [
    /((?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
    "$1<redacted>",
  ],
];

/**
 * A provider's failure message, made fit for a chat notice: one line,
 * anything shaped like a credential masked, capped. Masking runs before
 * the cap so a key cut in half at the boundary is still masked whole.
 */
export function summarizeFailureReason(reason: string): string {
  let line = reason.replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of SECRET_SHAPES) {
    line = line.replace(pattern, replacement);
  }
  return line.length > MEMORY_HEALTH_REASON_MAX_CHARS
    ? `${line.slice(0, MEMORY_HEALTH_REASON_MAX_CHARS - 1)}…`
    : line;
}
