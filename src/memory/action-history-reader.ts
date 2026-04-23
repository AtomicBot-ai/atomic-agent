import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { TraceEvent, TraceToolInvocation } from "../telemetry/trace/trace-event.js";

export interface TraceFileEntry {
  sessionId: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

/**
 * Enumerate session trace files in `<stateDir>/traces/`. Returns only
 * `<sessionId>.ndjson` files and skips sidecar artefacts.
 *
 * The directory may be missing entirely (tracing disabled, fresh
 * install) — callers must treat the empty list as a non-error signal.
 */
export function listTraceFiles(tracesDir: string): TraceFileEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(tracesDir);
  } catch (error) {
    if (isNoEntry(error)) return [];
    throw error;
  }
  const result: TraceFileEntry[] = [];
  for (const name of entries) {
    if (!name.endsWith(".ndjson")) continue;
    const path = join(tracesDir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    result.push({
      sessionId: name.slice(0, -".ndjson".length),
      path,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
    });
  }
  return result;
}

/**
 * Parse a single NDJSON trace file and yield `tool_invocation` events in
 * chronological order. Malformed lines are skipped silently — traces
 * are an append-only debug artefact, not a source of truth.
 */
export function readToolInvocationsFromFile(
  path: string,
): TraceToolInvocation[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isNoEntry(error)) return [];
    throw error;
  }
  const invocations: TraceToolInvocation[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: TraceEvent;
    try {
      parsed = JSON.parse(trimmed) as TraceEvent;
    } catch {
      continue;
    }
    if (!isToolInvocation(parsed)) continue;
    invocations.push(parsed);
  }
  return invocations;
}

function isToolInvocation(event: TraceEvent): event is TraceToolInvocation {
  return (event as { type?: unknown }).type === "tool_invocation";
}

function isNoEntry(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}
