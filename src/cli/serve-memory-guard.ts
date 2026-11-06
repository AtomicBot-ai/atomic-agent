import os from "node:os";
import v8 from "node:v8";

/**
 * ATO-1111 (ATO-424, ATO-761): a memory watchdog for a long `serve`.
 *
 * Windows desktops reported the agent dying mid-work after hours with exit
 * 0xC000009A (STATUS_INSUFFICIENT_RESOURCES): the OS refused it memory, and
 * the process vanished with no word and no clean teardown. The heap guard
 * (runtime/heap-guard.ts) only ever ran in the TUI; serve had nothing.
 *
 * This samples the process every minute. Past a soft line it says so on
 * stderr. Past the exit line it ends serve through its normal teardown
 * (`finally` in serve-command.ts: the HTTP server closes, the runtime shuts
 * down and the session stores are written) and serve exits with
 * MEMORY_GUARD_EXIT_CODE, which the desktop reads as "memory_guard" and
 * restarts. It waits for no turn to be running unless memory is past the
 * last-resort line, where waiting means the OS ends it anyway.
 *
 * It also writes one `[atomic-agent] memory …` line every ten minutes (and
 * at every rise in severity and right before it exits): numbers only, so the
 * desktop can attach the last sample to an exit report and the next sweep
 * can tell a growing agent from a small machine.
 *
 * Pure except for the injected reader, clock and timers.
 */

/** serve's exit code when the guard ended it: not 0/1/2/3, not a signal's 128+n. */
export const MEMORY_GUARD_EXIT_CODE = 86;

export interface MemorySample {
  rssBytes: number;
  heapUsedBytes: number;
  heapLimitBytes: number;
  totalMemBytes: number;
}

export interface MemoryThresholds {
  /** Heap fraction of the V8 ceiling that is reported as high. */
  heapWarn: number;
  /** Heap fraction at which serve exits once no turn is running. */
  heapExitIdle: number;
  /** Heap fraction at which serve exits even with a turn running. */
  heapExitBusy: number;
  /** RSS fraction of the machine's memory that is reported as high. */
  rssWarn: number;
  /** RSS fraction at which serve exits once no turn is running. */
  rssExitIdle: number;
  /** RSS fraction at which serve exits even with a turn running. */
  rssExitBusy: number;
}

/** Defaults: a proposal for the product owner, see the PR. */
export const DEFAULT_MEMORY_THRESHOLDS: MemoryThresholds = {
  heapWarn: 0.75,
  heapExitIdle: 0.85,
  heapExitBusy: 0.93,
  rssWarn: 0.4,
  rssExitIdle: 0.5,
  rssExitBusy: 0.65,
};

export const MEMORY_SAMPLE_INTERVAL_MS = 60_000;
export const MEMORY_LOG_INTERVAL_MS = 10 * 60_000;

export type MemoryVerdict = "ok" | "warn" | "exit";

export function readProcessMemory(): MemorySample {
  const heap = v8.getHeapStatistics();
  return {
    rssBytes: process.memoryUsage.rss(),
    heapUsedBytes: heap.used_heap_size,
    heapLimitBytes: heap.heap_size_limit,
    totalMemBytes: os.totalmem(),
  };
}

function ratio(part: number, whole: number): number {
  return Number.isFinite(part) && Number.isFinite(whole) && whole > 0 ? part / whole : 0;
}

/** One sample's verdict. `busy`: a turn is running, so only the last-resort lines end serve. */
export function judgeMemory(sample: MemorySample, busy: boolean, t: MemoryThresholds = DEFAULT_MEMORY_THRESHOLDS): MemoryVerdict {
  const heap = ratio(sample.heapUsedBytes, sample.heapLimitBytes);
  const rss = ratio(sample.rssBytes, sample.totalMemBytes);
  if (heap >= t.heapExitBusy || rss >= t.rssExitBusy) return "exit";
  if (!busy && (heap >= t.heapExitIdle || rss >= t.rssExitIdle)) return "exit";
  if (heap >= t.heapWarn || rss >= t.rssWarn) return "warn";
  return "ok";
}

const mb = (bytes: number): number => Math.round(bytes / 1_048_576);

/** The stderr line the desktop parses (desktop/main/agent-memory-sample.ts). Numbers only. */
export function formatMemoryLine(sample: MemorySample, verdict: MemoryVerdict): string {
  return (
    `[atomic-agent] memory ${verdict} rss_mb=${mb(sample.rssBytes)} heap_mb=${mb(sample.heapUsedBytes)} ` +
    `heap_limit_mb=${mb(sample.heapLimitBytes)} total_mb=${mb(sample.totalMemBytes)}\n`
  );
}

export interface ServeMemoryGuardDeps {
  isBusy: () => boolean;
  read?: () => MemorySample;
  write?: (line: string) => void;
  now?: () => number;
  thresholds?: MemoryThresholds;
  sampleIntervalMs?: number;
  logIntervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface ServeMemoryGuard {
  /** Resolves once memory is past an exit line: serve then tears down and exits with MEMORY_GUARD_EXIT_CODE. */
  readonly exhausted: Promise<void>;
  /** One check now; the interval calls this. Answers the verdict. */
  readonly check: () => MemoryVerdict;
  readonly stop: () => void;
}

/** `ATOMIC_AGENT_MEMORY_GUARD=0` turns the guard off (a person who raised the heap on purpose). */
export function memoryGuardDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ATOMIC_AGENT_MEMORY_GUARD === "0";
}

export function startServeMemoryGuard(deps: ServeMemoryGuardDeps): ServeMemoryGuard {
  const read = deps.read ?? readProcessMemory;
  const write = deps.write ?? ((line: string) => void process.stderr.write(line));
  const now = deps.now ?? Date.now;
  const t = deps.thresholds ?? DEFAULT_MEMORY_THRESHOLDS;
  const logEvery = deps.logIntervalMs ?? MEMORY_LOG_INTERVAL_MS;
  const rank: Record<MemoryVerdict, number> = { ok: 0, warn: 1, exit: 2 };
  let reported: MemoryVerdict = "ok";
  let lastLogAt = Number.NEGATIVE_INFINITY;
  let done = false;
  let resolveExhausted = (): void => {};
  const exhausted = new Promise<void>((resolve) => {
    resolveExhausted = resolve;
  });

  const check = (): MemoryVerdict => {
    if (done) return "exit";
    let sample: MemorySample;
    try {
      sample = read();
    } catch {
      return "ok";
    }
    const verdict = judgeMemory(sample, deps.isBusy(), t);
    const rose = rank[verdict] > rank[reported];
    reported = verdict;
    if (rose || now() - lastLogAt >= logEvery) {
      lastLogAt = now();
      write(formatMemoryLine(sample, verdict));
    }
    if (verdict === "exit") {
      done = true;
      write("[atomic-agent] memory guard: closing the agent cleanly before the system runs out of memory\n");
      stop();
      resolveExhausted();
    }
    return verdict;
  };

  const setIv = deps.setInterval ?? ((fn: () => void, ms: number) => {
    const h = setInterval(fn, ms);
    h.unref?.();
    return h;
  });
  const clearIv = deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  let handle: unknown = setIv(() => void check(), deps.sampleIntervalMs ?? MEMORY_SAMPLE_INTERVAL_MS);
  function stop(): void {
    if (handle !== null) clearIv(handle);
    handle = null;
  }
  return { exhausted, check, stop };
}
