/**
 * ATO-1186: the memory the desktop app itself uses, for the composer's
 * status line (renderer/status-line.js).
 *
 * The sum of every process Electron reports for this app (main, the
 * windows, the GPU and utility helpers): `app.getAppMetrics()`, whose
 * `memory.workingSetSize` is in kilobytes. It is the app's own memory,
 * not the agent's (`atag serve` is a separate process) nor a local
 * model's. Cheap: no child process, no file read.
 *
 * Pure: no Electron. The unit test drives it on made-up metrics.
 */

export interface AppMetricLike {
  memory?: { workingSetSize?: number } | null;
}

/** Bytes in use across the app's processes, or null when none reported a figure. */
export function appMemoryBytes(metrics: readonly AppMetricLike[] | null | undefined): number | null {
  if (!Array.isArray(metrics)) return null;
  let kb = 0;
  let seen = false;
  for (const m of metrics) {
    const n = m && m.memory ? Number(m.memory.workingSetSize) : NaN;
    if (!Number.isFinite(n) || n <= 0) continue;
    kb += n;
    seen = true;
  }
  return seen ? kb * 1024 : null;
}
