/**
 * The sweep's one question to a server it found on record: are you an
 * atomic-agent, which one, and are you busy?
 *
 * Kept apart from `serve-reaper.ts` because it is the only part that
 * touches the network, and the only part whose failure modes have to be
 * told apart: "nothing is listening there" means the record is stale,
 * while "listening but slow to answer" must not lose the record, or the
 * server behind it becomes invisible to every future sweep.
 */

/** The fields `GET /health` reports for the sweep, over loopback. */
export interface ServeHealth {
  readonly runtime?: string;
  readonly pid?: number;
  readonly ppid?: number;
  readonly busyTurns?: number;
}

export type ProbeOutcome =
  /** Something answered. It may or may not be one of ours. */
  | { readonly kind: "health"; readonly health: ServeHealth }
  /** Listening but too slow, or unreadable. The record is kept. */
  | { readonly kind: "unreachable" };

/** Nothing answered at all — the port is free, so the record is stale. */
const NOBODY_HOME: ProbeOutcome = { kind: "health", health: {} };

/**
 * `/health` awaits a single llama probe (`localModels.healthTimeoutMs`,
 * 3 s by default) and may spend another few seconds in the
 * OpenAI-compat fallback, so the budget here has to clear that — a hung
 * llama-server is exactly the state that strands servers, and timing it
 * out would drop the record of every server that has one.
 */
const PROBE_TIMEOUT_MS = 12_000;

function probeUrl(host: string, port: number): string {
  const target = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  // An IPv6 literal has to be bracketed or the URL is unparseable and
  // the record would be dropped as "nobody home".
  const authority = target.includes(":") && !target.startsWith("[") ? `[${target}]` : target;
  return `http://${authority}:${port}/health`;
}

export async function probeServeHealth(record: {
  readonly host: string;
  readonly port: number;
}): Promise<ProbeOutcome> {
  try {
    const res = await fetch(probeUrl(record.host, record.port), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return NOBODY_HOME;
    return { kind: "health", health: (await res.json()) as ServeHealth };
  } catch (err) {
    // A refused connection means the port is genuinely free; a timeout
    // or an abort means something is there but did not answer in time.
    const name = (err as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") return { kind: "unreachable" };
    const code = (err as { cause?: NodeJS.ErrnoException })?.cause?.code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH") {
      return NOBODY_HOME;
    }
    // Anything else (a malformed URL, a socket reset mid-body) is
    // ambiguous, so it fails closed: keep the record.
    return { kind: "unreachable" };
  }
}
