import {
  describePrefixSection,
  diffStablePrefixSections,
  hashStablePrefixSections,
  type StablePrefixSectionHashes,
} from "../prompt/stable-prefix-sections.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";

/**
 * The stable prefix of this step differs from the previous step of the
 * same session (ATO-316). A prefix that moves throws away the KV cache,
 * and on a local model re-reading it can cost minutes, so the change is
 * said live instead of only by `trace replay` afterwards.
 *
 * `expected` is true when the runtime itself just did something that
 * rebuilds the prefix (skills refreshed, MCP catalog rebuilt, a new
 * model or provider); `reasons` then says what. Unexpected drift is the
 * case worth a warning: a timestamp in a tool description, a skill list
 * that came back in another order.
 */
export interface PrefixDriftEvent {
  type: "prefix_drift";
  stepIndex: number;
  /** Section names as the prompt heads them (`system`, `tools`, `skills`, ...). */
  changedSections: string[];
  expected: boolean;
  /** Why the change was expected; empty when it was not. */
  reasons: string[];
  /**
   * Unexpected drift of these same sections was already reported in
   * this session. A surface can stay quieter on a repeat; the event
   * still fires so a trace or log sees every step.
   */
  repeat: boolean;
}

/** Every section; used by a cause that can reshape the whole prefix. */
export const ALL_PREFIX_SECTIONS = "all";

interface InvalidationNote {
  seq: number;
  reason: string;
  sections: readonly string[] | typeof ALL_PREFIX_SECTIONS;
}

const MAX_NOTES = 64;

/**
 * What the runtime did on purpose that rebuilds the prefix. One per
 * runtime: a skill refresh or an MCP rebuild reaches every session's
 * next step, so each session compares against the notes made since it
 * last built a prompt.
 */
export class PrefixInvalidationLedger {
  private seq = 0;
  private notes: InvalidationNote[] = [];

  note(reason: string, sections: readonly string[] | typeof ALL_PREFIX_SECTIONS): void {
    this.seq += 1;
    this.notes.push({ seq: this.seq, reason, sections });
    if (this.notes.length > MAX_NOTES) this.notes.shift();
  }

  current(): number {
    return this.seq;
  }

  /**
   * Notes made after `seq`. When older ones were already dropped the
   * answer is incomplete, so it says so: the caller then treats the
   * change as expected rather than warn about something it cannot rule
   * out.
   */
  since(seq: number): { notes: InvalidationNote[]; complete: boolean } {
    const notes = this.notes.filter((n) => n.seq > seq);
    return { notes, complete: notes.length === this.seq - seq };
  }
}

/**
 * Wrap a runtime action that rebuilds part of the prefix so the ledger
 * records it once the action settles (thrown or not: a half-applied
 * refresh still moves the prefix).
 */
export function notePrefixInvalidation(
  action: () => Promise<void>,
  ledger: PrefixInvalidationLedger,
  reason: string,
  sections: readonly string[] | typeof ALL_PREFIX_SECTIONS,
): () => Promise<void> {
  return async () => {
    try {
      await action();
    } finally {
      ledger.note(reason, sections);
    }
  };
}

interface SessionPrefixState {
  hashes: StablePrefixSectionHashes;
  ledgerSeq: number;
  shapeKey: string;
  warned: Set<string>;
}

/** Same bound and reason as `ProfileClipWarnings`. */
const MAX_TRACKED_SESSIONS = 256;

export interface ObservePrefixInput {
  sessionId: string;
  stepIndex: number;
  stablePrefix: string;
  /**
   * What the prefix is built for: provider, model, mode. A different
   * key means the operator switched model or route, which rebuilds the
   * whole prefix on purpose.
   */
  shapeKey: string;
  ledger?: PrefixInvalidationLedger;
}

/** Compares each step's prefix with the previous step of the same session. */
export class PrefixDriftTracker {
  private readonly sessions = new Map<string, SessionPrefixState>();

  observe(input: ObservePrefixInput): PrefixDriftEvent | null {
    const hashes = hashStablePrefixSections(input.stablePrefix);
    const ledgerSeq = input.ledger?.current() ?? 0;
    const prev = this.sessions.get(input.sessionId);
    this.sessions.delete(input.sessionId);
    const warned = prev?.warned ?? new Set<string>();
    this.sessions.set(input.sessionId, { hashes, ledgerSeq, shapeKey: input.shapeKey, warned });
    if (this.sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    if (prev === undefined) return null;
    const changed = diffStablePrefixSections(prev.hashes, hashes);
    if (changed.length === 0) return null;

    const reasons: string[] = [];
    const covered = new Set<string>();
    let coversAll = false;
    if (prev.shapeKey !== input.shapeKey) {
      reasons.push("model, route or run mode changed");
      coversAll = true;
    }
    if (input.ledger) {
      const { notes, complete } = input.ledger.since(prev.ledgerSeq);
      if (!complete) coversAll = true;
      for (const note of notes) {
        if (!reasons.includes(note.reason)) reasons.push(note.reason);
        if (note.sections === ALL_PREFIX_SECTIONS) coversAll = true;
        else for (const s of note.sections) covered.add(s);
      }
    }
    const expected =
      coversAll || changed.every((s) => covered.has(s.replace(/#\d+$/, "")));
    if (expected) {
      return { type: "prefix_drift", stepIndex: input.stepIndex, changedSections: changed, expected, reasons, repeat: false };
    }
    const signature = changed.join(",");
    const repeat = warned.has(signature);
    warned.add(signature);
    return { type: "prefix_drift", stepIndex: input.stepIndex, changedSections: changed, expected, reasons: [], repeat };
  }
}

export interface ReportPrefixDriftInput extends ObservePrefixInput {
  tracker: PrefixDriftTracker;
  logger?: StructuredLogger;
  emit?: (event: PrefixDriftEvent) => void;
}

/** Observe one step's prefix and, when it moved, log and emit. */
export function reportPrefixDrift(input: ReportPrefixDriftInput): void {
  const event = input.tracker.observe(input);
  if (event === null) return;
  const fields = {
    sessionId: input.sessionId,
    stepIndex: event.stepIndex,
    changedSections: event.changedSections,
    reasons: event.reasons,
  };
  if (event.expected) input.logger?.info("stable prefix rebuilt", fields);
  else input.logger?.warn("stable prefix changed between steps with no known cause", fields);
  input.emit?.(event);
}

function sectionList(event: PrefixDriftEvent): string {
  return [...new Set(event.changedSections.map(describePrefixSection))].join(", ");
}

/** The chat line for unexpected drift, shared by the TUI and other hosts. */
export function prefixDriftWarning(event: PrefixDriftEvent): string {
  return `Warning: the cached part of the prompt changed between steps (${sectionList(event)}) and nothing the agent did explains it. The model has to re-read the whole prompt, which is slow on a local model. \`atomic-agent trace replay\` on this session shows the drift.`;
}

/** The dim feed line for drift the runtime caused on purpose. */
export function prefixDriftInfoLine(event: PrefixDriftEvent): string {
  const why = event.reasons.length > 0 ? `: ${event.reasons.join("; ")}` : "";
  return `» prompt prefix rebuilt (${sectionList(event)})${why}`;
}
