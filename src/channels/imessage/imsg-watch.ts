/**
 * Supervises the long-running `imsg watch --json` child.
 *
 * The child is the channel's only inbound transport: it follows
 * `~/Library/Messages/chat.db` and prints one JSON line per new
 * message. This module owns spawning it, splitting its stdout into
 * lines, and restarting it with the shared backoff when it exits.
 *
 * Restarts resume from the last new-message rowid (`--since-rowid`,
 * exclusive) so a message that arrived while the child was down is
 * still answered, and none is answered twice.
 *
 * A missing binary is terminal (`onFatal`): retrying `spawn` on a file
 * that does not exist only fills the log. Every other exit, including a
 * permission failure, is reported (`onExit`) and retried: the operator
 * may grant the permission while we wait, and the backoff caps at a
 * minute.
 */

import { spawn } from "node:child_process";

import { backoffMs } from "../reconnect-backoff.js";
import { LineSplitter, parseImsgLine, type ImsgMessage } from "./imsg-event.js";
import { classifyImsgFailure, type ImsgFailure } from "./imsg-errors.js";

/** The subset of `ChildProcess` the watcher uses. */
export interface WatchChild {
  stdout: { setEncoding(enc: "utf8"): unknown; on(ev: "data", cb: (chunk: string) => void): unknown } | null;
  stderr: { setEncoding(enc: "utf8"): unknown; on(ev: "data", cb: (chunk: string) => void): unknown } | null;
  on(ev: "spawn", cb: () => void): unknown;
  on(ev: "error", cb: (err: Error) => void): unknown;
  on(ev: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnLike = (file: string, args: readonly string[]) => WatchChild;

export interface ImsgWatcherDeps {
  binary: string;
  onMessage: (message: ImsgMessage) => void;
  /** The child is running (spawned). */
  onRunning: () => void;
  /** The child exited; a restart is scheduled after this returns. */
  onExit: (failure: ImsgFailure) => void;
  /** The binary cannot be started at all; no restart is scheduled. */
  onFatal: (failure: ImsgFailure) => void;
  spawnImpl?: SpawnLike;
  /** Test seam for the backoff schedule. */
  delayMs?: (attempt: number) => number;
  /** A child that ran this long resets the backoff. */
  stableAfterMs?: number;
  now?: () => number;
}

/** Keep only the tail of stderr: enough to classify, bounded in memory. */
const STDERR_TAIL_CHARS = 4096;

const defaultSpawn: SpawnLike = (file, args) =>
  spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"] }) as unknown as WatchChild;

export class ImsgWatcher {
  private child: WatchChild | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private attempt = 0;
  private sinceRowId = 0;
  /** Bumped per spawn so late events from a replaced child are ignored. */
  private generation = 0;

  constructor(private readonly deps: ImsgWatcherDeps) {}

  /** The argv for `imsg watch`. Exported shape for tests. */
  args(): string[] {
    const args = ["watch", "--json"];
    if (this.sinceRowId > 0) args.push("--since-rowid", String(this.sinceRowId));
    return args;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.spawnChild();
  }

  /** Kill the child and cancel any pending restart. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.generation += 1;
    const child = this.child;
    this.child = null;
    try {
      child?.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }

  private spawnChild(): void {
    const generation = ++this.generation;
    const startedAt = (this.deps.now ?? Date.now)();
    let stderr = "";
    let settled = false;
    let child: WatchChild;
    try {
      child = (this.deps.spawnImpl ?? defaultSpawn)(this.deps.binary, this.args());
    } catch (err) {
      // Synchronous spawn failures (bad argument types, EACCES on some
      // platforms) are as terminal as ENOENT for a configured binary.
      this.stopped = true;
      this.deps.onFatal(classifyImsgFailure(err));
      return;
    }
    this.child = child;
    const live = (): boolean => !this.stopped && generation === this.generation;

    const splitter = new LineSplitter((line) => {
      if (!live()) return;
      const message = parseImsgLine(line);
      if (!message) return;
      if (message.rowId > this.sinceRowId) this.sinceRowId = message.rowId;
      this.deps.onMessage(message);
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => splitter.push(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });

    let spawned = false;
    child.on("spawn", () => {
      spawned = true;
      if (live()) this.deps.onRunning();
    });
    child.on("error", (err) => {
      if (settled || !live()) return;
      // An error before `spawn` means the executable could not be run at
      // all (ENOENT: not installed; EACCES: not executable). Retrying the
      // same path cannot fix that, and Node does not promise a `close`.
      if (!spawned || (err as NodeJS.ErrnoException).code === "ENOENT") {
        settled = true;
        this.stopped = true;
        this.child = null;
        this.deps.onFatal(classifyImsgFailure(err, stderr));
        return;
      }
      // A running child's error (a failed kill) is followed by `close`.
      stderr = `${stderr}\n${err.message}`.slice(-STDERR_TAIL_CHARS);
    });
    child.on("close", (code, signal) => {
      if (settled || !live()) return;
      settled = true;
      splitter.end();
      this.child = null;
      const ranFor = (this.deps.now ?? Date.now)() - startedAt;
      if (ranFor >= (this.deps.stableAfterMs ?? 60_000)) this.attempt = 0;
      const reason = new Error(`imsg watch exited (${signal ?? `code ${code ?? "?"}`})`);
      this.deps.onExit(classifyImsgFailure(reason, stderr));
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.stopped) return;
    const delay = (this.deps.delayMs ?? backoffMs)(this.attempt);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) this.spawnChild();
    }, delay);
    // One pending restart must never keep the process alive on its own.
    this.timer.unref?.();
  }
}
