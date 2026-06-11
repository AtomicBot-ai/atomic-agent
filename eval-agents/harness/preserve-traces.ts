import { existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Copy the per-case NDJSON traces out of the ephemeral temp-workspace into a
 * persistent location BEFORE the workspace is deleted by `cleanup()`.
 *
 * atomic-agent writes traces to `<stateDir>/traces/<sessionId>.ndjson`; the
 * temp-workspace is removed after every case, so without this step the raw
 * traces are gone the moment metrics are harvested. Best-effort: a missing
 * traces dir (e.g. competitor adapters that do not emit NDJSON) or a copy
 * failure never aborts the run.
 *
 * Returns the number of trace files preserved.
 */
export function preserveTraceFiles(stateDir: string, outDir: string, taskId: string): number {
  const tracesDir = join(stateDir, "traces");
  if (!existsSync(tracesDir)) {
    return 0;
  }

  let copied = 0;
  try {
    const entries = readdirSync(tracesDir).filter((name) => name.endsWith(".ndjson"));
    if (entries.length === 0) {
      return 0;
    }
    const destDir = join(outDir, taskId);
    mkdirSync(destDir, { recursive: true });
    for (const name of entries) {
      try {
        copyFileSync(join(tracesDir, name), join(destDir, name));
        copied += 1;
      } catch {
        // best-effort per file
      }
    }
  } catch {
    // best-effort
  }
  return copied;
}
