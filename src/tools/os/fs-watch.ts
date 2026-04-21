import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";

/**
 * One filesystem event. `path` is relative to the watched root so the
 * output stays compact; consumers that need absolute paths can join
 * with `rootAbsolute` from `details`.
 */
export interface WatchEvent {
  kind: "add" | "change" | "unlink" | "addDir" | "unlinkDir";
  path: string;
  timestamp: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_EVENTS_HARD = 10_000;

interface WatchArgs {
  path: string;
  timeoutMs: number;
  recursive: boolean;
  events: ReadonlySet<WatchEvent["kind"]>;
  ignoreInitial: boolean;
  maxEvents: number;
  stopAfterFirst: boolean;
}

const ALLOWED_EVENTS: readonly WatchEvent["kind"][] = [
  "add",
  "change",
  "unlink",
  "addDir",
  "unlinkDir",
];

export const osFsWatchTool: ToolDefinition = {
  name: "os.fs.watch",
  description:
    "Watch a file or directory for changes for up to `timeoutMs` (default 5s, cap 60s). Returns a list of events. This is a one-shot, blocking watch — use when you know a change is imminent.",
  readonly: true,
  async run(rawArgs, ctx) {
    const args = await parseArgs(rawArgs, ctx.workingDir);
    const absolute = isAbsolute(args.path)
      ? args.path
      : resolve(ctx.workingDir, args.path);

    const watcher = watch(absolute, {
      persistent: false,
      ignoreInitial: args.ignoreInitial,
      depth: args.recursive ? undefined : 0,
      usePolling: false,
      awaitWriteFinish: false,
    });
    const collected: WatchEvent[] = [];
    let timedOut = false;

    await new Promise<void>((resolvePromise) => {
      const deadline = setTimeout(() => {
        timedOut = true;
        resolvePromise();
      }, args.timeoutMs);

      const cleanup = (): void => {
        clearTimeout(deadline);
        resolvePromise();
      };

      const onAbort = (): void => {
        cleanup();
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      watcher.on("all", (event, changedPath) => {
        if (!args.events.has(event as WatchEvent["kind"])) return;
        collected.push({
          kind: event as WatchEvent["kind"],
          path: relative(absolute, changedPath) || ".",
          timestamp: new Date().toISOString(),
        });
        if (collected.length >= args.maxEvents) {
          ctx.signal.removeEventListener("abort", onAbort);
          cleanup();
          return;
        }
        if (args.stopAfterFirst) {
          ctx.signal.removeEventListener("abort", onAbort);
          cleanup();
        }
      });

      watcher.on("error", (err) => {
        collected.push({
          kind: "change",
          path: `(watcher error: ${(err as Error).message})`,
          timestamp: new Date().toISOString(),
        });
        ctx.signal.removeEventListener("abort", onAbort);
        cleanup();
      });
    });

    await closeWatcher(watcher);

    return compressToolResult({
      tool: "os.fs.watch",
      status: "ok",
      output: formatEvents(collected, timedOut, args.timeoutMs),
      details: {
        rootAbsolute: absolute,
        timeoutMs: args.timeoutMs,
        recursive: args.recursive,
        eventsReceived: collected.length,
        timedOut,
        truncated: collected.length >= args.maxEvents,
        events: collected,
      },
    });
  },
};

async function parseArgs(
  raw: Record<string, unknown>,
  workingDir: string,
): Promise<WatchArgs> {
  const path = raw.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("os.fs.watch: `path` must be a non-empty string");
  }
  const absolute = isAbsolute(path) ? path : resolve(workingDir, path);
  try {
    await stat(absolute);
  } catch {
    throw new Error(`os.fs.watch: path does not exist: ${absolute}`);
  }

  const timeoutMs = parseTimeout(raw.timeoutMs);
  const recursive = raw.recursive === true;
  const events = parseEvents(raw.events);
  const ignoreInitial = raw.ignoreInitial !== false;
  const maxEvents = parseMaxEvents(raw.maxEvents);
  const stopAfterFirst = raw.stopAfterFirst === true;

  return {
    path,
    timeoutMs,
    recursive,
    events,
    ignoreInitial,
    maxEvents,
    stopAfterFirst,
  };
}

function parseTimeout(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_TIMEOUT_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error("os.fs.watch: `timeoutMs` must be a positive number");
  }
  if (raw > MAX_TIMEOUT_MS) {
    throw new Error(
      `os.fs.watch: \`timeoutMs\` exceeds the ${MAX_TIMEOUT_MS}ms cap (use a shorter timeout and re-run if needed)`,
    );
  }
  return Math.floor(raw);
}

function parseEvents(raw: unknown): ReadonlySet<WatchEvent["kind"]> {
  if (raw === undefined || raw === null) {
    return new Set<WatchEvent["kind"]>(["add", "change", "unlink"]);
  }
  if (!Array.isArray(raw)) {
    throw new Error("os.fs.watch: `events` must be an array of event names");
  }
  const out = new Set<WatchEvent["kind"]>();
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new Error("os.fs.watch: `events` entries must be strings");
    }
    if (!(ALLOWED_EVENTS as readonly string[]).includes(entry)) {
      throw new Error(
        `os.fs.watch: unknown event ${JSON.stringify(entry)} (allowed: ${ALLOWED_EVENTS.join(", ")})`,
      );
    }
    out.add(entry as WatchEvent["kind"]);
  }
  if (out.size === 0) {
    throw new Error("os.fs.watch: `events` cannot be empty");
  }
  return out;
}

function parseMaxEvents(raw: unknown): number {
  if (raw === undefined || raw === null) return MAX_EVENTS_HARD;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error("os.fs.watch: `maxEvents` must be a positive number");
  }
  return Math.min(MAX_EVENTS_HARD, Math.floor(raw));
}

async function closeWatcher(watcher: FSWatcher): Promise<void> {
  try {
    await watcher.close();
  } catch {
    // chokidar occasionally throws during teardown on fast cycles; nothing
    // useful we can do with the error beyond swallowing it here.
  }
}

function formatEvents(
  events: readonly WatchEvent[],
  timedOut: boolean,
  timeoutMs: number,
): string {
  if (events.length === 0) {
    return timedOut
      ? `(no events within ${timeoutMs}ms)`
      : "(watch stopped before timeout)";
  }
  const lines = events.map((e) => `${e.timestamp}  ${e.kind.padEnd(9)} ${e.path}`);
  if (timedOut) lines.push(`(timeout reached after ${timeoutMs}ms)`);
  return lines.join("\n");
}
