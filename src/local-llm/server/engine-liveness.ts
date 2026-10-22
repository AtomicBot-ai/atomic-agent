import { readFileSync } from "node:fs";
import { resolvePidFilePath } from "../backend-paths.js";
import { coreOperationInProgress } from "../core/core-operation.js";
import { classifyPidLiveness } from "./daemon-lifecycle.js";

/**
 * What the managed chat engine's process looks like from disk, right now.
 *
 *   - `alive`   the recorded pid answers signal 0 (a process owned by
 *               another user counts: it is running, we just cannot signal it).
 *   - `dead`    a pid is recorded and no such process exists.
 *   - `no_pid`  nothing is recorded: the model was never started or was
 *               stopped.
 *   - `unknown` an engine operation is under way (a start, model load, stop
 *               or llama.cpp/Core install holds the engine lock), or the pid
 *               file could not be read for another reason.
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

export interface ManagedEngineLivenessProbes {
  operationInProgress?: (dataDir: string) => boolean;
  pidLiveness?: (pid: number) => "alive" | "foreign" | "dead";
}

export function readManagedEngineLiveness(
  dataDir: string,
  probes: ManagedEngineLivenessProbes = {},
): ManagedEngineLiveness {
  const operationInProgress = probes.operationInProgress ?? coreOperationInProgress;
  const pidLiveness = probes.pidLiveness ?? classifyPidLiveness;
  try {
    if (operationInProgress(dataDir)) return "unknown";
  } catch {
    return "unknown";
  }
  let raw: string;
  try {
    raw = readFileSync(resolvePidFilePath(dataDir), "utf-8").trim();
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "ENOENT"
      ? "no_pid"
      : "unknown";
  }
  const pid = Number(raw);
  // An empty or garbled record is what `readRunningPid` treats as nothing
  // recorded: no process can be behind it.
  if (!Number.isInteger(pid) || pid <= 0) return "no_pid";
  return pidLiveness(pid) === "dead" ? "dead" : "alive";
}
