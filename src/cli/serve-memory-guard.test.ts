import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEMORY_THRESHOLDS,
  formatMemoryLine,
  judgeMemory,
  MEMORY_GUARD_EXIT_CODE,
  memoryGuardDisabled,
  readProcessMemory,
  startServeMemoryGuard,
  type MemorySample,
} from "./serve-memory-guard.js";

const GB = 1_073_741_824;
const sample = (heapGb: number, rssGb = 1, limitGb = 4, totalGb = 16): MemorySample => ({
  rssBytes: rssGb * GB,
  heapUsedBytes: heapGb * GB,
  heapLimitBytes: limitGb * GB,
  totalMemBytes: totalGb * GB,
});

/** A guard on a hand-moved clock and a manual interval. */
function harness(read: () => MemorySample, busy = false) {
  const lines: string[] = [];
  let clock = 0;
  let cleared = false;
  const guard = startServeMemoryGuard({
    isBusy: () => busy,
    read,
    write: (l) => lines.push(l),
    now: () => clock,
    setInterval: () => "h",
    clearInterval: () => {
      cleared = true;
    },
  });
  return { guard, lines, tick: (ms: number) => (clock += ms), cleared: () => cleared };
}

describe("judgeMemory", () => {
  it("is ok with headroom", () => {
    expect(judgeMemory(sample(1), false)).toBe("ok");
  });

  it("warns past the soft heap line", () => {
    expect(judgeMemory(sample(4 * DEFAULT_MEMORY_THRESHOLDS.heapWarn), false)).toBe("warn");
  });

  it("exits past the idle line only when no turn runs", () => {
    const s = sample(4 * 0.88);
    expect(judgeMemory(s, false)).toBe("exit");
    expect(judgeMemory(s, true)).toBe("warn");
  });

  it("exits past the last-resort line even with a turn running", () => {
    expect(judgeMemory(sample(4 * 0.95), true)).toBe("exit");
  });

  it("judges RSS against the machine, for native memory the heap does not see", () => {
    expect(judgeMemory(sample(1, 7), false)).toBe("warn");
    expect(judgeMemory(sample(1, 8.5), false)).toBe("exit");
    expect(judgeMemory(sample(1, 8.5), true)).toBe("warn");
    expect(judgeMemory(sample(1, 11), true)).toBe("exit");
  });

  it("treats an unknown ceiling as headroom rather than dividing by zero", () => {
    expect(judgeMemory(sample(3, 1, 0, 0), false)).toBe("ok");
  });
});

describe("formatMemoryLine", () => {
  it("carries numbers only, in the shape the desktop parses", () => {
    expect(formatMemoryLine(sample(1, 2), "warn")).toBe(
      "[atomic-agent] memory warn rss_mb=2048 heap_mb=1024 heap_limit_mb=4096 total_mb=16384\n",
    );
  });
});

describe("startServeMemoryGuard", () => {
  it("logs the first sample, then only every log interval while severity holds", () => {
    const h = harness(() => sample(1));
    h.guard.check();
    h.tick(60_000);
    h.guard.check();
    expect(h.lines).toHaveLength(1);
    h.tick(10 * 60_000);
    h.guard.check();
    expect(h.lines).toHaveLength(2);
  });

  it("logs at once when severity rises", () => {
    let heap = 1;
    const h = harness(() => sample(heap));
    h.guard.check();
    heap = 3.1;
    expect(h.guard.check()).toBe("warn");
    expect(h.lines.at(-1)).toContain("memory warn");
  });

  it("resolves exhausted and stops sampling past the exit line", async () => {
    const h = harness(() => sample(3.6));
    expect(h.guard.check()).toBe("exit");
    await expect(h.guard.exhausted).resolves.toBeUndefined();
    expect(h.cleared()).toBe(true);
    expect(h.lines.some((l) => l.includes("memory guard"))).toBe(true);
  });

  it("waits for the running turn below the last-resort line", () => {
    const h = harness(() => sample(3.6), true);
    expect(h.guard.check()).toBe("warn");
  });

  it("a reader that throws is not a reason to exit", () => {
    const h = harness(() => {
      throw new Error("no stats");
    });
    expect(h.guard.check()).toBe("ok");
  });
});

describe("guard wiring facts", () => {
  it("uses an exit code no other serve exit uses", () => {
    expect([0, 1, 2, 3].includes(MEMORY_GUARD_EXIT_CODE)).toBe(false);
    expect(MEMORY_GUARD_EXIT_CODE).toBeLessThan(128);
  });

  it("is turned off only by ATOMIC_AGENT_MEMORY_GUARD=0", () => {
    expect(memoryGuardDisabled({ ATOMIC_AGENT_MEMORY_GUARD: "0" })).toBe(true);
    expect(memoryGuardDisabled({})).toBe(false);
  });

  it("reads real numbers from this process", () => {
    const s = readProcessMemory();
    expect(s.rssBytes).toBeGreaterThan(0);
    expect(s.heapLimitBytes).toBeGreaterThan(s.heapUsedBytes);
    expect(s.totalMemBytes).toBeGreaterThan(0);
  });
});
