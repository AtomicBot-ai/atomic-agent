/**
 * The net under `serve-orphan-guard.ts`: a marker file per live server,
 * and a sweep that clears the ones already stranded.
 *
 * Every `serve` drops `<stateDir>/serve/<pid>.json` when it starts
 * listening and removes it once it has finished shutting down — the
 * same advisory marker-file discipline as `local-llm/session-registry.ts`.
 * A server that dies, or wedges, without releasing leaves its record
 * behind on purpose: that is what the sweep is looking for.
 *
 * The sweep runs at every `serve` boot, so each new server tidies up
 * after the generation before it, and is reachable by hand as
 * `atomic-agent serve --reap`.
 *
 * Its whole design problem is that it must never touch a server that is
 * still useful to somebody, and "has no parent" is NOT that test. A
 * deliberate daemon — `--no-parent-exit`, or anything started by
 * launchd/systemd — is parentless by design and must be left alone
 * forever; an earlier draft of this module used parentlessness as its
 * kill criterion, which made it a daemon-killer and nothing else.
 *
 * What the sweep actually requires is positive evidence of abandonment:
 * the record names the pid that started the server, and only when *that
 * specific process* is gone is the server an orphan. See
 * `reapOrphanedServes`.
 */

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isAlive } from "./serve-orphan-guard.js";
import { probeServeHealth, type ProbeOutcome } from "./serve-probe.js";

const SERVE_DIR = "serve";

/** What a live `serve` writes about itself, for the sweep to find. */
export interface ServeRecord {
  readonly pid: number;
  /**
   * The pid that started this server. The sweep reaps only when this
   * exact process is gone — the one fact that separates "abandoned"
   * from "parentless on purpose".
   */
  readonly bootPpid: number;
  /**
   * Set when the server is meant to outlive its parent: `--no-parent-exit`,
   * or a boot that was already parentless. Never reaped, whatever else
   * is true of it.
   */
  readonly daemon: boolean;
  readonly host: string;
  readonly port: number;
  readonly cwd: string;
  readonly startedAt: string;
}

export type ReapVerdict =
  /** The record named a dead pid, or a port that is nobody we know. Dropped. */
  | "stale"
  /** Meant to outlive its parent. Never touched, record kept. */
  | "daemon"
  /** The process that started it is still alive. Left alone, record kept. */
  | "owned"
  /** Listening but not answering in time. Left alone, record KEPT for next time. */
  | "unreachable"
  /** Abandoned but mid-turn. Left alone; work outranks tidiness. */
  | "busy"
  /** Abandoned, idle, positively identified. Signalled. */
  | "reaped";

export interface ReapOutcome {
  readonly record: ServeRecord;
  readonly verdict: ReapVerdict;
}

function serveDir(stateDir: string): string {
  return join(stateDir, SERVE_DIR);
}

/**
 * Record this server as live. Returns a release function, to be called
 * once teardown has finished rather than when it starts — a server
 * still holding its port must still be on record. Releasing twice is safe.
 */
export function registerServe(stateDir: string, record: ServeRecord): () => void {
  const dir = serveDir(stateDir);
  const file = join(dir, `${record.pid}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(record), "utf8");
  } catch {
    // Best-effort. A server that could not register behaves exactly
    // like one from before this module existed: the parent watch still
    // protects it, only the sweep cannot see it.
  }
  return () => {
    try {
      unlinkSync(file);
    } catch {
      // Already gone — release is idempotent.
    }
  };
}

/** Every parseable record on disk, with the path it came from. */
export function readServeRecords(
  stateDir: string,
): readonly { readonly file: string; readonly record: ServeRecord }[] {
  let entries: string[];
  try {
    entries = readdirSync(serveDir(stateDir));
  } catch {
    return [];
  }
  const out: { file: string; record: ServeRecord }[] = [];
  for (const entry of entries) {
    const file = join(serveDir(stateDir), entry);
    let record: ServeRecord | null = null;
    try {
      record = JSON.parse(readFileSync(file, "utf8")) as ServeRecord;
    } catch {
      record = null;
    }
    if (record && Number.isInteger(record.pid) && record.pid > 0) {
      out.push({ file, record });
      continue;
    }
    try {
      unlinkSync(file);
    } catch {
      // Someone else cleaned it first — fine.
    }
  }
  return out;
}

export interface ReapOptions {
  readonly stateDir: string;
  /** Injected in tests. */
  readonly probe?: (record: ServeRecord) => Promise<ProbeOutcome>;
  readonly signal?: (pid: number, sig: NodeJS.Signals) => void;
  readonly graceMs?: number;
}

/**
 * Clear servers that have been abandoned — and only those.
 *
 * The bar for sending a signal is deliberately high, because killing a
 * server somebody is talking to is far worse than leaving a stray alive
 * another day. Every one of these must hold:
 *
 *  - the record is not ours, and is not marked `daemon`;
 *  - its `bootPpid` — the process that started it — is **gone**. This is
 *    the evidence of abandonment, and it is why a launchd daemon or a
 *    `--no-parent-exit` server is never a candidate no matter how long
 *    it lives. It also works where orphans reparent to a subreaper
 *    rather than to init, as under `systemd --user` or a container init;
 *  - the pid is alive, and `GET /health` on the recorded port answers
 *    `runtime: "atomic-agent"` reporting *the pid we recorded* — the
 *    identity check, and what makes pid reuse harmless;
 *  - that answer agrees it has been reparented away from `bootPpid`;
 *  - it reports no turn in flight.
 *
 * Every one of those gates fails **closed**: a missing or non-numeric
 * field reads as "still in use", never as "safe to kill". A server that
 * is listening but too slow to answer keeps its record and is looked at
 * again next time, because a dropped record is a server that can never
 * be swept again.
 *
 * Note that strays predating this change answer `/health` without a
 * `pid` and have no record at all, so they are never signalled. They
 * have to be cleared by hand, once.
 */
export async function reapOrphanedServes(opts: ReapOptions): Promise<readonly ReapOutcome[]> {
  const probe = opts.probe ?? probeServeHealth;
  const signal = opts.signal ?? ((pid, sig): void => void process.kill(pid, sig));
  const outcomes: ReapOutcome[] = [];

  for (const { file, record } of readServeRecords(opts.stateDir)) {
    if (record.pid === process.pid) continue;
    const drop = (): void => {
      try {
        unlinkSync(file);
      } catch {
        // Someone else cleaned it first — fine.
      }
    };
    const verdict = (v: ReapVerdict): void => void outcomes.push({ record, verdict: v });

    // Meant to outlive its parent. Nothing below applies.
    if (record.daemon === true) {
      verdict("daemon");
      continue;
    }
    if (!isAlive(record.pid)) {
      drop();
      verdict("stale");
      continue;
    }
    // The only evidence of abandonment we accept. A record written
    // before this field existed has no `bootPpid`, so it fails closed.
    if (!Number.isInteger(record.bootPpid) || isAlive(record.bootPpid)) {
      verdict("owned");
      continue;
    }

    const probed = await probe(record);
    if (probed.kind === "unreachable") {
      // Listening, but slower than the probe's budget — a hung llama
      // probe inside `/health` does this. Keep the record: dropping it
      // would make the server invisible to every future sweep.
      verdict("unreachable");
      continue;
    }
    const health = probed.health;
    if (health.runtime !== "atomic-agent" || health.pid !== record.pid) {
      drop();
      verdict("stale");
      continue;
    }
    if (typeof health.ppid !== "number" || health.ppid === record.bootPpid) {
      verdict("owned");
      continue;
    }
    if (typeof health.busyTurns !== "number" || health.busyTurns > 0) {
      verdict("busy");
      continue;
    }

    // Signalling races the process exiting on its own: between the
    // liveness check and the kill it may already be gone (`ESRCH`), or
    // be owned by another user (`EPERM`). Either way what we wanted has
    // happened, and neither may take the sweep — or `--reap` — down.
    trySignal(signal, record.pid, "SIGTERM");
    await waitForExit(record.pid, opts.graceMs ?? 10_000);
    if (isAlive(record.pid)) trySignal(signal, record.pid, "SIGKILL");
    drop();
    verdict("reaped");
  }
  return outcomes;
}

/** One line per record, for `--reap` and the boot-time sweep. */
export function formatReapOutcomes(outcomes: readonly ReapOutcome[]): string {
  if (outcomes.length === 0) return "serve: no stray servers on record\n";
  const lines = outcomes.map(
    ({ record, verdict }) =>
      `  ${verdict.padEnd(11)} pid ${record.pid} on ${record.host}:${record.port} (started ${record.startedAt})`,
  );
  return [`serve: swept ${outcomes.length} record(s)`, ...lines, ""].join("\n");
}

function trySignal(
  signal: (pid: number, sig: NodeJS.Signals) => void,
  pid: number,
  sig: NodeJS.Signals,
): void {
  try {
    signal(pid, sig);
  } catch {
    // Already gone, or not ours to signal. Nothing left to do either way.
  }
}

async function waitForExit(pid: number, graceMs: number): Promise<void> {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
  }
}
