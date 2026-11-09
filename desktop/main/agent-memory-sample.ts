/**
 * ATO-1111: the agent's own memory, as it last reported it.
 *
 * `atag serve` writes one numbers-only line every ten minutes, and whenever
 * its memory rises a step (src/cli/serve-memory-guard.ts formatMemoryLine):
 *
 *   [atomic-agent] memory warn rss_mb=2048 heap_mb=1024 heap_limit_mb=4096 total_mb=16384
 *
 * main keeps the newest one per agent, so an AgentExited report carries the
 * agent's memory shortly before it went (as buckets, sentry/exit-reason.ts).
 * Pure: no Electron. The unit test drives it on made-up lines.
 */

export interface AgentMemorySample {
  verdict: "ok" | "warn" | "exit";
  rssMb: number;
  heapMb: number;
  heapLimitMb: number;
  totalMb: number;
}

const LINE = /\[atomic-agent\] memory (ok|warn|exit) rss_mb=(\d+) heap_mb=(\d+) heap_limit_mb=(\d+) total_mb=(\d+)/;

/** The sample a line carries, or null for any other line. */
export function parseAgentMemoryLine(line: string): AgentMemorySample | null {
  if (typeof line !== "string" || !line.includes("[atomic-agent] memory ")) return null;
  const m = LINE.exec(line);
  if (!m) return null;
  return {
    verdict: m[1] as AgentMemorySample["verdict"],
    rssMb: Number(m[2]),
    heapMb: Number(m[3]),
    heapLimitMb: Number(m[4]),
    totalMb: Number(m[5]),
  };
}

/** The newest sample of the running agent; cleared when a new agent starts. */
export class AgentMemoryTracker {
  private last: AgentMemorySample | null = null;

  /** Every agent log line; keeps the sample when the line is one. */
  observe(line: string): void {
    const s = parseAgentMemoryLine(line);
    if (s) this.last = s;
  }

  /** A new agent starts: the old one's numbers are not its. */
  reset(): void {
    this.last = null;
  }

  latest(): AgentMemorySample | null {
    return this.last;
  }
}
