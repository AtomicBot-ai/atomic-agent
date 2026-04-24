import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";

import {
  buildDebugBundleSnapshot,
  debugBundleFileName,
  type DebugBundleSnapshot,
} from "./build-snapshot.js";
import { traceFilePath } from "../../tracing/trace/trace-sink.js";
import type { TuiState } from "../tui-state.js";

export interface DebugBundleManifest {
  /** ISO 8601 timestamp the archive was assembled at. */
  capturedAt: string;
  /** `process.version`, e.g. `v22.22.2`. */
  node: string;
  /** `process.platform`, e.g. `darwin`. */
  platform: string;
  /** `process.arch`, e.g. `arm64`. */
  arch: string;
  /** NDJSON trace directory resolved by the runtime config. */
  traceDir: string;
  /** Resolved trace-enabled flag at capture time. */
  traceEnabled: boolean;
  /** Working directory the TUI session was bound to. */
  workingDir: string;
  /** The session live in the TUI at capture time (nullable pre-start). */
  currentSessionId: string | null;
  /** Per-session trace inclusion report — one row per requested id. */
  traces: Array<{
    sessionId: string;
    included: boolean;
    bytes?: number;
    reason?: string;
  }>;
}

export interface WriteDebugBundleOptions {
  snapshot: DebugBundleSnapshot;
  /** Trace directory (typically `runtime.config.tracing.trace.dir`). */
  traceDir: string;
  /** `config.tracing.trace.enabled` at capture time. */
  traceEnabled: boolean;
  /**
   * Candidate session ids. Caller is responsible for uniqueness —
   * typically `{ currentSessionId } ∪ sessionStore.listRecent(N)`.
   */
  sessionIds: readonly string[];
  /** Destination directory; created on demand. */
  outDir: string;
  /** Optional clock override for deterministic filenames in tests. */
  now?: Date;
}

export interface WriteDebugBundleResult {
  path: string;
  includedTraces: number;
  skippedTraces: number;
  bytes: number;
}

/**
 * Assemble a zip with `manifest.json`, `tui-snapshot.json` and the
 * NDJSON trace for every requested session id that exists on disk,
 * then write it to `outDir`. Missing or unreadable trace files do not
 * fail the export — they are recorded in the manifest so the receiver
 * can tell a runaway disk from a genuine gap.
 */
export async function writeDebugBundleZip(
  options: WriteDebugBundleOptions,
): Promise<WriteDebugBundleResult> {
  const zip = new JSZip();
  const manifest: DebugBundleManifest = {
    capturedAt: (options.now ?? new Date()).toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    traceDir: options.traceDir,
    traceEnabled: options.traceEnabled,
    workingDir: options.snapshot.session.workingDir,
    currentSessionId: options.snapshot.session.sessionId,
    traces: [],
  };

  zip.file("tui-snapshot.json", JSON.stringify(options.snapshot, null, 2));

  let includedTraces = 0;
  let skippedTraces = 0;
  for (const sessionId of options.sessionIds) {
    const path = traceFilePath(options.traceDir, sessionId);
    try {
      const stats = await stat(path);
      if (!stats.isFile()) {
        manifest.traces.push({
          sessionId,
          included: false,
          reason: "not a regular file",
        });
        skippedTraces += 1;
        continue;
      }
      const body = await readFile(path);
      zip.file(`traces/${sessionId}.ndjson`, body);
      manifest.traces.push({
        sessionId,
        included: true,
        bytes: body.byteLength,
      });
      includedTraces += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      manifest.traces.push({ sessionId, included: false, reason });
      skippedTraces += 1;
    }
  }

  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const payload = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  await mkdir(options.outDir, { recursive: true });
  const filePath = join(options.outDir, debugBundleFileName(options.now));
  await writeFile(filePath, payload);

  return {
    path: filePath,
    includedTraces,
    skippedTraces,
    bytes: payload.byteLength,
  };
}

/**
 * Convenience wrapper used by the TUI wiring: builds the snapshot from
 * `state` and forwards every other option to `writeDebugBundleZip`.
 */
export async function captureAndWriteDebugBundle(args: {
  state: TuiState;
  traceDir: string;
  traceEnabled: boolean;
  sessionIds: readonly string[];
  outDir: string;
  now?: Date;
}): Promise<WriteDebugBundleResult> {
  return writeDebugBundleZip({
    snapshot: buildDebugBundleSnapshot(args.state),
    traceDir: args.traceDir,
    traceEnabled: args.traceEnabled,
    sessionIds: args.sessionIds,
    outDir: args.outDir,
    ...(args.now ? { now: args.now } : {}),
  });
}
