/**
 * Timeout resolution and wording for `os.shell.run` (F47).
 *
 * Before config v67 an omitted `timeoutMs` meant no limit at all, and a
 * recursive grep over a home directory ran for twenty minutes until a
 * person killed it — `agent.toolTimeoutMs` never applied to the shell.
 * Now the operator's `tools.shell.defaultTimeoutMs` fills the gap, and
 * the two sources part ways when they elapse: at the model's own
 * `timeoutMs` the command is killed (it asked for a bound); at the
 * default it is detached as a job that the model can `wait` for or
 * `kill` (shell-jobs.ts) — a build the operator's default interrupted
 * is not a build the model wanted stopped.
 */

export type ShellTimeoutSource = "default" | "explicit";

export interface ResolvedShellTimeout {
  /** Milliseconds; `0` = no limit. */
  timeoutMs: number;
  /** Where the number came from — decides kill (explicit) vs detach (default). */
  source: ShellTimeoutSource;
}

/**
 * An explicit `timeoutMs` (a finite number; `0` or negative = none)
 * wins; anything else — omitted, `null`, a string — takes the configured
 * default, where `0` (or nothing configured) again means no limit.
 */
export function resolveShellTimeout(
  rawTimeoutMs: unknown,
  defaultTimeoutMs: number,
): ResolvedShellTimeout {
  if (typeof rawTimeoutMs === "number" && Number.isFinite(rawTimeoutMs)) {
    return { timeoutMs: Math.max(0, rawTimeoutMs), source: "explicit" };
  }
  const fallback =
    Number.isFinite(defaultTimeoutMs) && defaultTimeoutMs > 0
      ? defaultTimeoutMs
      : 0;
  return { timeoutMs: fallback, source: "default" };
}

/** `600000` → `10 min`, `5000` → `5 s`, `1500` → `1.5 s`. Exact; for limits. */
export function formatShellDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

/** `754321` → `13 min`, `4000000` → `1 h 7 min`, `12345` → `12 s`. Rounded; for elapsed time. */
export function formatShellElapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * The first line of a result stopped at the model's own `timeoutMs`:
 * what stopped it and what to pass for a longer run.
 */
export function formatShellTimeoutNotice(timeout: ResolvedShellTimeout): string {
  return `stopped after ${formatShellDuration(timeout.timeoutMs)} (timeoutMs) — output so far below; pass a larger timeoutMs for a longer run, or 0 for no limit`;
}

export interface ShellDetachNoticeInput {
  jobId: number;
  /** How long this call waited before giving the job back. */
  waitedMs: number;
  /** A `wait` call that elapsed again, rather than the first detach. */
  again: boolean;
  /** The per-call wait a bare `{"wait": id}` gets; `0` = unbounded. */
  defaultTimeoutMs: number;
}

/**
 * The first line of a detached result: the job's id and the three ways
 * to act on it. Said above the output so the model reads it before the
 * tail of a build log.
 */
export function formatShellDetachNotice(input: ShellDetachNoticeInput): string {
  const { jobId } = input;
  const after = formatShellDuration(input.waitedMs);
  const perCall =
    input.defaultTimeoutMs > 0
      ? ` (up to another ${formatShellDuration(input.defaultTimeoutMs)} per call)`
      : "";
  const forms = `os.shell.run {"wait": ${jobId}} keeps waiting${perCall}, {"kill": ${jobId}} stops it`;
  if (!input.again) {
    return `still running after ${after} (job ${jobId}) — output so far below; ${forms}, pass timeoutMs for a longer first wait`;
  }
  return `still running after another ${after} (job ${jobId}) — output so far below; ${forms}, pass timeoutMs with the wait for a longer one`;
}

/** The timeout sentence of the tool description, for the configured default. */
export function describeShellTimeoutDefault(defaultTimeoutMs: number): string {
  if (Number.isFinite(defaultTimeoutMs) && defaultTimeoutMs > 0) {
    const limit = formatShellDuration(defaultTimeoutMs);
    return `Timeout: default ${limit} — a command still running then is not killed but detached as a job, and the result names it: {"wait": id} waits for it (up to another ${limit} per call; timeoutMs sets the wait), {"kill": id} stops it, {"jobs": true} lists this session's jobs; a job dies when the turn ends unless the call carried keep: true. Pass \`timeoutMs\` to stop the command at an explicit limit instead, \`0\` for none.`;
  }
  return "By default there is no timeout (the command runs until it exits or the turn is cancelled); pass `timeoutMs` to set an explicit limit.";
}
