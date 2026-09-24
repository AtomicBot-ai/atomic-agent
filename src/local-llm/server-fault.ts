/**
 * Read the managed server's own log for the faults that leave it *up*
 * and useless.
 *
 * A llama-server that cannot allocate keeps its socket, answers
 * `/health`, accepts tasks and fails every decode. Nothing above it can
 * tell that apart from a slow model: the request simply never produces
 * a token. Observed in the field — 298 Metal out-of-memory errors in
 * one session, the daemon listening the whole time, and the operator's
 * report was "huge memory spend with no result".
 *
 * So the signal has to be read where it exists, which is the log. This
 * is deliberately a small table of exact strings rather than anything
 * clever: a fault that is not recognised produces nothing, and nothing
 * is what every caller did before.
 */

export interface ServerFault {
  /** What the operator should read. One line, already actionable. */
  readonly summary: string;
  /** How many times the signature appears in the tail that was read. */
  readonly occurrences: number;
}

interface FaultPattern {
  readonly needle: string;
  readonly describe: (count: number) => string;
}

/**
 * Ordered: the first match wins, so the most specific cause is the one
 * reported. A GPU that ran out of memory also produces decode failures,
 * and naming the decode failure would send the operator looking at the
 * model instead of at the memory.
 */
const PATTERNS: readonly FaultPattern[] = [
  {
    needle: "kIOGPUCommandBufferCallbackErrorOutOfMemory",
    describe: (n) =>
      `the GPU ran out of memory ${n} time${n === 1 ? "" : "s"} — the server kept its socket and failed every request. ` +
      `Lower \`localModels.managed.contextSize\` (it is sized automatically from the model's trained context, ` +
      `which on a large model is far more than the machine can hold), or set \`localModels.managed.swaFull\` to "off".`,
  },
  {
    needle: "out of memory",
    describe: (n) =>
      `the backend reported out of memory ${n} time${n === 1 ? "" : "s"} — the server kept its socket and failed requests. ` +
      `Lower \`localModels.managed.contextSize\`.`,
  },
  {
    needle: "couldn't bind HTTP server socket",
    describe: () =>
      `the server could not take its port — another llama-server already has it. ` +
      `Stop the other one, or change \`localModels.url\`.`,
  },
  {
    needle: "failed to decode",
    describe: (n) =>
      `the model failed to decode ${n} time${n === 1 ? "" : "s"} — the server answered but produced no tokens. ` +
      `The log above the first failure says why.`,
  },
];

/**
 * The first recognised fault in `logText`, or `null`.
 *
 * Counts every occurrence, because one is a hiccup and three hundred is
 * the answer: the number is what tells an operator whether they are
 * looking at the cause or at a symptom they can ignore.
 */
/**
 * The marker every managed launch writes before llama.cpp says anything
 * of its own. Everything after the last one belongs to the daemon that
 * is running now.
 */
const LAUNCH_MARKER = "[atomic-agent] launch: model ";

/**
 * Narrow a log to the current daemon's own run.
 *
 * The log file is append-only across restarts, so without this a fault
 * from a daemon that died hours ago is reported beside a `daemon:
 * running / health: ok` line — which is exactly the mistake the fault
 * line exists to prevent, made in the other direction. Caught on the
 * first live run of this feature: 298 out-of-memory errors from an
 * earlier launch were reported against a healthy server.
 *
 * A log with no marker at all (an external server, a truncated tail) is
 * returned whole: something is better than nothing, and the alternative
 * is silence on every non-managed setup.
 */
export function currentRunLog(logText: string): string {
  const at = logText.lastIndexOf(LAUNCH_MARKER);
  return at === -1 ? logText : logText.slice(at);
}

export function describeServerFault(logText: string): ServerFault | null {
  const scoped = currentRunLog(logText);
  for (const pattern of PATTERNS) {
    // Case-insensitive on purpose: llama.cpp spells its own errors
    // inconsistently across backends, and this table exists to be
    // matched, not to be a grammar.
    const haystack = scoped.toLowerCase();
    const needle = pattern.needle.toLowerCase();
    let count = 0;
    let at = haystack.indexOf(needle);
    while (at !== -1) {
      count += 1;
      at = haystack.indexOf(needle, at + needle.length);
    }
    if (count > 0) {
      return { summary: pattern.describe(count), occurrences: count };
    }
  }
  return null;
}
