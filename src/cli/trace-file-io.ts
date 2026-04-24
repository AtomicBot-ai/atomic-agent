import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

import type { TraceEvent } from "../tracing/index.js";

/**
 * Stream a session NDJSON trace file, yielding one `TraceEvent` per
 * line. Malformed lines are skipped — traces are treated as best-effort
 * diagnostics, not as authoritative state.
 */
export async function* iterateTraceFile(
  path: string,
): AsyncGenerator<TraceEvent, void, void> {
  if (!existsSync(path)) return;
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        yield JSON.parse(trimmed) as TraceEvent;
      } catch {
        continue;
      }
    }
  } finally {
    rl.close();
    stream.close();
  }
}

export async function readTraceFile(path: string): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  for await (const event of iterateTraceFile(path)) {
    events.push(event);
  }
  return events;
}

export interface TraceSummary {
  sessionId: string;
  path: string;
  sizeBytes: number;
  modifiedAt: Date;
  startedAt: Date | null;
  workingDir: string | null;
}

/**
 * List every NDJSON trace file in `dir`, newest first. Each summary
 * carries the metadata extracted from the first `session_started` event
 * (when present) so `atomic-agent trace list` can show a meaningful
 * snapshot without opening a pager.
 */
export async function listTraceSummaries(
  dir: string,
  options: { limit?: number } = {},
): Promise<TraceSummary[]> {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir).filter((name) => name.endsWith(".ndjson"));
  const withStats = entries.map((name) => {
    const path = join(dir, name);
    const stat = statSync(path);
    return {
      sessionId: name.replace(/\.ndjson$/, ""),
      path,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime,
    };
  });
  withStats.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  const sliced = options.limit ? withStats.slice(0, options.limit) : withStats;
  const summaries: TraceSummary[] = [];
  for (const entry of sliced) {
    const header = await readFirstSessionStarted(entry.path);
    summaries.push({
      sessionId: entry.sessionId,
      path: entry.path,
      sizeBytes: entry.sizeBytes,
      modifiedAt: entry.modifiedAt,
      startedAt: header ? new Date(header.ts) : null,
      workingDir: header ? header.workingDir : null,
    });
  }
  return summaries;
}

async function readFirstSessionStarted(
  path: string,
): Promise<{ ts: number; workingDir: string } | null> {
  for await (const event of iterateTraceFile(path)) {
    if (event.type === "session_started") {
      return { ts: event.ts, workingDir: event.workingDir };
    }
  }
  return null;
}
