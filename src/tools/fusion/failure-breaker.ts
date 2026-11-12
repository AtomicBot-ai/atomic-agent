import type { WorkerTaskResult } from "./worker-result.js";

/**
 * Stop a fan-out that keeps failing the same way (ATO-1406).
 *
 * A Discord user ran fusion with a subscription CLI on both legs: twelve
 * workers over three delegations, 31 minutes, most of them dying on the
 * same tool-protocol mismatch, and the orchestrator re-sent essentially
 * the same plan twice. Nothing in a fan-out remembered that the last
 * five workers had died of one cause, so every round started clean and
 * the subscription's limit paid for it.
 *
 * Two kinds of failure are told apart here, because their remedies are:
 *
 * - A **blocker** says this configuration cannot work at all: the
 *   worker model does not speak the agent's tool-call protocol, the CLI
 *   is not installed or not signed in, the leg is out of credit. Another
 *   worker on the same leg fails the same way, so the first one is
 *   enough: nothing new is started, and the next delegation on that leg
 *   this turn is refused.
 * - A **repeat** is any other failure whose message, with the numbers,
 *   paths and quoted bits taken out, is the same as the ones before it.
 *   `REPEAT_FAILURE_STREAK` of them in a row (a success in between
 *   resets the count) stop the fan-out; the same repeat stopping two
 *   delegations in one turn refuses the third.
 *
 * Workers already running are never cut: they may still finish, and a
 * row that came back is never thrown away. Only new starts are refused.
 */

/** Identical non-blocker failures in a row that stop a fan-out. */
export const REPEAT_FAILURE_STREAK = 3;

/** Delegations in one turn a repeat may stop before the next is refused. */
export const REPEAT_TRIPS_BEFORE_REFUSAL = 2;

export interface WorkerFailureClass {
  /** True for a failure that says the setup cannot work (see above). */
  blocker: boolean;
  /** What two failures must share to count as the same one. */
  signature: string;
  /** Plain words for the person, via the orchestrator. */
  label: string;
}

/**
 * The worker model could not produce, or the leg could not carry, a
 * tool call in the agent's format. Matched on the wording the parsers
 * and providers actually use (`ToolCallParseError`,
 * `ToolCallArgumentsParseError`, a gateway refusing `tools`, a grammar
 * the server rejected) and on the reporter's own words.
 */
const TOOL_PROTOCOL = new RegExp(
  [
    // ToolCallParseError's own messages (tool-call-grammar.ts).
    String.raw`invalid tool-call JSON`,
    String.raw`\btool-call (?:root|array(?: root)?|args|array entry \d+) must`,
    String.raw`\btool-call body is empty`,
    String.raw`\btool-call must include`,
    // ToolCallArgumentsParseError (openai-tool-call-adapter.ts).
    String.raw`arguments are not a valid JSON object`,
    // A gateway or model that refuses tools outright.
    String.raw`tools? (?:is|are) not supported`,
    String.raw`does(?:n't| not) support (?:tools|tool calls|tool use|function calling)`,
    String.raw`function[- ]calling is not (?:supported|enabled)`,
    // The words a report uses for it ("tool/protocol mismatch").
    String.raw`tool[- /]?(?:call|use)?[ /-]?protocol mismatch`,
    String.raw`tool[- ]?(?:call|use) (?:protocol|format) mismatch`,
  ].join("|"),
  "i",
);
/** `SubscriptionCliNotInstalledError` / `SubscriptionCliSpawnError` and their kin. */
const CLI_MISSING =
  /isn't installed \(the `[^`]+` command was not found\)|was not found on PATH|could not be started \(spawn|spawn \S+ ENOENT/i;
/** `SubscriptionCliAuthError` and a provider rejecting the key. */
const NOT_SIGNED_IN =
  /is not signed in|not logged in|please (?:log|sign) in|(?:HTTP|status|code)\s*401\b|^401\b|unauthori[sz]ed|invalid (?:api )?key|incorrect api key|authentication failed/i;
/**
 * Out of credit or the subscription's usage limit. Deliberately narrower
 * than the hint's `CREDIT_OR_QUOTA`: a bare 429 or "rate limit" can pass
 * in seconds, so it only stops a fan-out as a repeat, never at once.
 */
const OUT_OF_CREDIT =
  /(?:HTTP|status|code)\s*402\b|^402\b|402 Payment|payment required|insufficient (?:credits?|funds|balance|quota)|out of (?:credits?|funds)|quota (?:exceeded|exhausted)|exceeded (?:your|the) (?:current )?quota|usage limit|(?:subscription|plan|weekly|daily|hourly|5-hour) limit|is out of credit/i;

// The protocol check first: its messages carry positions and counts
// ("at position 401") that the other patterns must not claim.
const BLOCKERS: ReadonlyArray<{ re: RegExp; signature: string; label: string }> = [
  {
    re: TOOL_PROTOCOL,
    signature: "blocker:tool-protocol",
    label:
      "the worker model's replies do not fit the agent's tool-call protocol, so its tools never run",
  },
  {
    re: CLI_MISSING,
    signature: "blocker:cli-missing",
    label: "the worker leg's command-line tool is not installed or cannot start",
  },
  {
    re: NOT_SIGNED_IN,
    signature: "blocker:not-signed-in",
    label: "the worker leg is not signed in or its key was rejected",
  },
  {
    re: OUT_OF_CREDIT,
    signature: "blocker:out-of-credit",
    label: "the worker leg is out of credit or hit its usage limit",
  },
];

/** How much of an error the signature and the label keep. */
const SIGNATURE_CHARS = 160;

/**
 * The failure class of a finished row, or `undefined` when the row is
 * not a failure this breaker counts: a success, a cut-off (`timeout`,
 * `max_steps`), a hand-back, a task the breaker or a cap kept from
 * starting.
 */
export function classifyWorkerFailure(
  result: Pick<WorkerTaskResult, "status" | "error">,
): WorkerFailureClass | undefined {
  if (result.status !== "failed") return undefined;
  const error = (result.error ?? "").trim();
  if (error.length === 0 || error.startsWith("not started:")) return undefined;
  for (const blocker of BLOCKERS) {
    if (blocker.re.test(error)) {
      return { blocker: true, signature: blocker.signature, label: blocker.label };
    }
  }
  return {
    blocker: false,
    signature: `repeat:${normaliseError(error)}`,
    label: firstLine(error),
  };
}

/**
 * The parts of an error message that differ between two workers dying
 * of the same thing: numbers (ports, counts, ids, durations), quoted
 * values, paths, hex. Taken out so the rest compares.
 */
export function normaliseError(error: string): string {
  return firstLine(error)
    .toLowerCase()
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<q>")
    .replace(/(?:[a-z]:)?(?:[\\/][\w.@+-]+){2,}/gi, "<path>")
    .replace(/\b[0-9a-f]{8,}\b/g, "<hex>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

function firstLine(error: string): string {
  const line = error.split("\n", 1)[0]!.trim();
  return line.length <= SIGNATURE_CHARS
    ? line
    : `${[...line].slice(0, SIGNATURE_CHARS).join("")}…`;
}

export interface BreakerTrip {
  signature: string;
  blocker: boolean;
  label: string;
  /** How many identical failures tripped it. */
  count: number;
  /** The worker leg the failures came from. */
  providerId: string;
}

/**
 * One fan-out's breaker. `observe` every row as it finishes (in
 * completion order); `stopReason` is what `shouldStart` returns once it
 * has tripped.
 */
export class FanoutFailureBreaker {
  private streakSignature: string | undefined;
  private streakCount = 0;
  private trip: BreakerTrip | undefined;

  constructor(
    private readonly providerId: string,
    private readonly streak: number = REPEAT_FAILURE_STREAK,
  ) {}

  observe(result: Pick<WorkerTaskResult, "status" | "error">): void {
    if (this.trip !== undefined) return;
    if (result.status === "ok" || result.status === "no_changes") {
      this.streakSignature = undefined;
      this.streakCount = 0;
      return;
    }
    const failure = classifyWorkerFailure(result);
    if (failure === undefined) return;
    if (failure.signature === this.streakSignature) {
      this.streakCount += 1;
    } else {
      this.streakSignature = failure.signature;
      this.streakCount = 1;
    }
    if (failure.blocker || this.streakCount >= this.streak) {
      this.trip = {
        signature: failure.signature,
        blocker: failure.blocker,
        label: failure.label,
        count: this.streakCount,
        providerId: this.providerId,
      };
    }
  }

  tripped(): BreakerTrip | undefined {
    return this.trip;
  }

  /** The reason a task is not started, once tripped. */
  stopReason(): string | undefined {
    return this.trip === undefined ? undefined : describeTrip(this.trip);
  }
}

/** Plain words for a trip, used on rows, in the result and in a refusal. */
export function describeTrip(trip: BreakerTrip): string {
  return trip.blocker
    ? `the fan-out was stopped because ${trip.label} — another worker on this leg would fail the same way`
    : `the fan-out was stopped after ${trip.count} workers in a row failed with the same error ("${trip.label}")`;
}

/** What the orchestrator is told to do after a trip. */
export const FAILURE_BREAKER_INSTRUCTION =
  "Do not re-send these tasks with the same approach and do not do the work yourself. Reply to the person now, in plain words: say which error kept stopping the workers, what is done and what is not, and what would fix it (another worker model or provider, signing in, more credit) — let them decide how to continue.";

/**
 * Whether an earlier trip this turn refuses a new delegation on
 * `providerId`: a blocker on the same leg, or the same repeat having
 * already stopped `REPEAT_TRIPS_BEFORE_REFUSAL` delegations.
 */
export function refusalFromTrips(
  trips: readonly BreakerTrip[],
  providerId: string,
  otherLegs: readonly string[] = [],
): BreakerTrip | undefined {
  const legs = new Set([providerId, ...otherLegs]);
  const blocker = trips.find((t) => t.blocker && legs.has(t.providerId));
  if (blocker !== undefined) return blocker;
  const counts = new Map<string, number>();
  for (const trip of trips) {
    if (trip.blocker) continue;
    const n = (counts.get(trip.signature) ?? 0) + 1;
    counts.set(trip.signature, n);
    if (n >= REPEAT_TRIPS_BEFORE_REFUSAL) return trip;
  }
  return undefined;
}
