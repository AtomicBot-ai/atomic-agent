import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { machineBootTimeMs, writtenBeforeBoot } from "../core/core-operation.js";

/**
 * A chat model start is on its way in some process (ATO-421).
 *
 * The engine operation lock and the pid file say nothing during the first
 * part of a start: the backend check, the port and model checks, the
 * device listing and the context fit all run before Core's load takes the
 * lock, and the pid is written only once the load returns. A turn that
 * meets a refused connection in that window read the engine as `dead`
 * (`no_pid_file`, lock free) and ended after its 8 s grace, while the
 * desktop's restart or the TUI's launch start was still coming. On Windows
 * the `models start` the desktop spawns for a restart spends most of that
 * grace booting. This marker covers the window: written as the start
 * begins, removed as it ends, whatever the outcome.
 *
 * The file holds the starter's pid and nothing else, so another program
 * (the desktop, which cannot import this module) can write the same
 * marker before it spawns the start. A marker whose owner is gone, that
 * predates the last boot, or that is older than `CHAT_START_PENDING_STALE_MS`
 * is not a start on its way. Readers never remove it.
 */
export const CHAT_START_PENDING_FILE = "chat-start.pending";

/**
 * How old a marker may be and still mean a start is on its way. Longer
 * than a first-run engine install plus a large model's load; past it a
 * live owner is taken to be stuck, as `CORE_OPERATION_STALE_MS` does for
 * the lock. The turn's own wait is shorter anyway (ATO-1434's ceiling).
 */
export const CHAT_START_PENDING_STALE_MS = 15 * 60_000;

/** No pid yet in a freshly created marker: the owner writes it in the same call. */
const MARKER_WRITE_WINDOW_MS = 10_000;

export function chatStartPendingPath(dataDir: string): string {
  return join(dataDir, CHAT_START_PENDING_FILE);
}

/** Starts this process has under way, per data dir: nested marks share one file. */
const held = new Map<string, number>();

/**
 * Mark a chat start as on its way and answer the undo. Nested marks in
 * one process (the `models start` command around the daemon start inside
 * it) keep one marker, removed by the outermost undo. The undo removes
 * the file only while it still names this process, so it never takes
 * away another starter's marker. Never throws: a marker that cannot be
 * written leaves the start exactly as it was before this existed.
 */
export function markChatStartPending(dataDir: string): () => void {
  const count = held.get(dataDir) ?? 0;
  held.set(dataDir, count + 1);
  if (count === 0) {
    try {
      writeFileSync(chatStartPendingPath(dataDir), String(process.pid), { mode: 0o600 });
    } catch {
      /* the start goes on without its marker */
    }
  }
  let undone = false;
  return () => {
    if (undone) return;
    undone = true;
    const left = (held.get(dataDir) ?? 1) - 1;
    if (left > 0) {
      held.set(dataDir, left);
      return;
    }
    held.delete(dataDir);
    try {
      const path = chatStartPendingPath(dataDir);
      if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
    } catch {
      /* already gone, or another starter's now */
    }
  };
}

/** Run `start` with the marker held for its whole length. */
export async function withChatStartPending<T>(dataDir: string, start: () => Promise<T>): Promise<T> {
  const done = markChatStartPending(dataDir);
  try {
    return await start();
  } finally {
    done();
  }
}

export interface ChatStartPendingProbes {
  now?: () => number;
  bootTimeMs?: () => number;
  /** Signal 0 on `pid`: `alive` (another user's process included) or `dead`. */
  pidLiveness?: (pid: number) => "alive" | "dead";
}

function defaultPidLiveness(pid: number): "alive" | "dead" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "alive";
  }
}

/**
 * Whether a chat start is on its way right now, by the marker alone.
 * Read only. Any read error answers `false`: a marker that cannot be
 * judged must not keep a turn waiting.
 */
export function chatStartPending(dataDir: string, probes: ChatStartPendingProbes = {}): boolean {
  const path = chatStartPendingPath(dataDir);
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(path, "utf8").trim();
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return false;
  }
  const now = (probes.now ?? Date.now)();
  let bootTimeMs: number;
  try {
    bootTimeMs = (probes.bootTimeMs ?? machineBootTimeMs)();
  } catch {
    bootTimeMs = Number.NaN;
  }
  if (writtenBeforeBoot(mtimeMs, bootTimeMs)) return false;
  if (now - mtimeMs > CHAT_START_PENDING_STALE_MS) return false;
  const pid = Number(raw);
  if (raw === "" || !Number.isInteger(pid) || pid < 1) return now - mtimeMs <= MARKER_WRITE_WINDOW_MS;
  if (pid === process.pid) return held.has(dataDir);
  return (probes.pidLiveness ?? defaultPidLiveness)(pid) === "alive";
}
