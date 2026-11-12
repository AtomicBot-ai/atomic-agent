import { readFileSync, statSync } from "node:fs";
import { resolvePidFilePath } from "../backend-paths.js";
import {
  lockMeansOperationInProgress,
  machineBootTimeMs,
  readCoreOperationLock,
  writtenBeforeBoot,
  type CoreOperationLockState,
} from "../core/core-operation.js";
import { classifyPidLiveness } from "./daemon-lifecycle.js";

/**
 * What the managed chat engine's process looks like from disk, right now.
 *
 *   - `alive`   the recorded pid answers signal 0 (a process owned by
 *               another user counts: it is running, we just cannot signal it).
 *   - `dead`    a pid is recorded and no such process exists, or the
 *               record predates the machine's last boot.
 *   - `no_pid`  nothing is recorded: the model was never started or was
 *               stopped.
 *   - `unknown` an engine operation is under way (a start, model load, stop
 *               or llama.cpp/Core install holds the engine lock), or the pid
 *               file could not be read for another reason. A lock its owner
 *               left behind (gone, from before the last boot, or never given
 *               a pid) is not an operation under way (ATO-1275).
 *
 * Both managed engines keep the model process's pid in the same file:
 * llama-server writes its child's pid right after the spawn, Atomic Core
 * writes the session's pid once the load returns. A Core load in progress
 * holds the engine operation lock, which is why that is checked first.
 *
 * Read only. Unlike `readRunningPid` it never removes a stale pid file: a
 * caller asking "is it running?" from inside a turn must not change what
 * the next start or status call sees.
 */
export type ManagedEngineLiveness = "alive" | "dead" | "no_pid" | "unknown";

/**
 * Why the liveness reads what it reads, as a fixed word (ATO-1275). It
 * travels in error reports, so it names a branch, never a pid or a path.
 *
 *   - `pid_alive` / `pid_foreign` / `pid_dead`  the recorded pid's answer.
 *   - `pid_before_boot`                         the pid file was written
 *                                               before the last boot: its
 *                                               process is gone, even if
 *                                               the pid now names another.
 *   - `no_pid_file` / `pid_empty`               nothing usable recorded.
 *   - `lock_held`                               another live process holds
 *                                               the engine operation lock.
 *   - `lock_held_self`                          this process holds it.
 *   - `lock_writing`                            a lock with no pid yet, young.
 *   - `lock_unreadable` / `lock_probe_failed`   the lock could not be judged.
 *   - `pid_unreadable`                          the pid file exists and
 *                                               could not be read.
 */
export type ManagedEngineLivenessReason =
  | "pid_alive"
  | "pid_foreign"
  | "pid_dead"
  | "pid_before_boot"
  | "no_pid_file"
  | "pid_empty"
  | "lock_held"
  | "lock_held_self"
  | "lock_writing"
  | "lock_unreadable"
  | "lock_probe_failed"
  | "pid_unreadable";

export interface ManagedEngineLivenessReport {
  state: ManagedEngineLiveness;
  reason: ManagedEngineLivenessReason;
  /** The engine operation lock as read (`probe_failed` when the read threw). */
  lock: CoreOperationLockState | "probe_failed";
}

export interface ManagedEngineLivenessProbes {
  operationLock?: (dataDir: string) => CoreOperationLockState;
  pidLiveness?: (pid: number) => "alive" | "foreign" | "dead";
  /** When this machine last booted, wall clock ms. */
  bootTimeMs?: () => number;
}

const LOCK_REASON: Partial<Record<CoreOperationLockState, ManagedEngineLivenessReason>> = {
  held: "lock_held",
  held_self: "lock_held_self",
  writing: "lock_writing",
  unreadable: "lock_unreadable",
};

export function readManagedEngineLiveness(
  dataDir: string,
  probes: ManagedEngineLivenessProbes = {},
): ManagedEngineLiveness {
  return explainManagedEngineLiveness(dataDir, probes).state;
}

/**
 * `readManagedEngineLiveness` with the branch that decided it and the lock
 * reading, for error reports. A lock left behind by an owner that is gone
 * (dead pid, written before the last boot, never given a pid) does not
 * hide a dead engine (ATO-1275); a lock a live process holds still does.
 */
export function explainManagedEngineLiveness(
  dataDir: string,
  probes: ManagedEngineLivenessProbes = {},
): ManagedEngineLivenessReport {
  const operationLock = probes.operationLock ?? readCoreOperationLock;
  const pidLiveness = probes.pidLiveness ?? classifyPidLiveness;
  let lock: CoreOperationLockState;
  try {
    lock = operationLock(dataDir);
  } catch {
    return { state: "unknown", reason: "lock_probe_failed", lock: "probe_failed" };
  }
  if (lockMeansOperationInProgress(lock)) {
    return { state: "unknown", reason: LOCK_REASON[lock] ?? "lock_held", lock };
  }
  let raw: string;
  try {
    raw = readFileSync(resolvePidFilePath(dataDir), "utf-8").trim();
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "ENOENT"
      ? { state: "no_pid", reason: "no_pid_file", lock }
      : { state: "unknown", reason: "pid_unreadable", lock };
  }
  const pid = Number(raw);
  // An empty or garbled record is what `readRunningPid` treats as nothing
  // recorded: no process can be behind it.
  if (!Number.isInteger(pid) || pid <= 0) return { state: "no_pid", reason: "pid_empty", lock };
  // A record from before the last reboot: pids start over at boot, so the
  // number may now name an unrelated live process (ATO-1275).
  if (pidFileBeforeBoot(dataDir, probes.bootTimeMs ?? machineBootTimeMs)) {
    return { state: "dead", reason: "pid_before_boot", lock };
  }
  const answer = pidLiveness(pid);
  if (answer === "dead") return { state: "dead", reason: "pid_dead", lock };
  return { state: "alive", reason: answer === "foreign" ? "pid_foreign" : "pid_alive", lock };
}

function pidFileBeforeBoot(dataDir: string, bootTimeMs: () => number): boolean {
  try {
    return writtenBeforeBoot(statSync(resolvePidFilePath(dataDir)).mtimeMs, bootTimeMs());
  } catch {
    return false;
  }
}
