import type { MonitorWake } from "../tools/os/index.js";

/**
 * The transcript line the person sees when a monitored background job
 * wakes the open chat (ATO-2436), above the turn it starts or steers.
 */
export function formatMonitorWakeLine(wake: MonitorWake): string {
  const parts: string[] = [];
  if (wake.lineCount > 0) {
    parts.push(`printed ${wake.lineCount} matching line${wake.lineCount === 1 ? "" : "s"}`);
  }
  if (wake.exited) parts.push("exited");
  const what = parts.length > 0 ? parts.join(" and ") : "has news";
  return `background job ${wake.jobId} (${wake.command}) ${what}; the agent is told (monitor)`;
}
