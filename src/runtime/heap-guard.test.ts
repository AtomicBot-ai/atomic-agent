import { describe, it, expect } from "vitest";
import {
  classifyHeap,
  createHeapGuard,
  readProcessHeap,
  HEAP_WARN_RATIO,
  HEAP_CRITICAL_RATIO,
  type HeapReading,
} from "./heap-guard.js";

const GB = 1_073_741_824;
const reading = (usedGb: number, limitGb = 4): HeapReading => ({
  usedBytes: usedGb * GB,
  limitBytes: limitGb * GB,
});

describe("classifyHeap", () => {
  it("stays quiet with headroom", () => {
    const s = classifyHeap(reading(1));
    expect(s.severity).toBe("ok");
    expect(s.message).toBeNull();
  });

  it("warns at the warn ratio and names the remedy", () => {
    const s = classifyHeap(reading(4 * HEAP_WARN_RATIO));
    expect(s.severity).toBe("warn");
    expect(s.message).toContain("max-old-space-size");
  });

  it("escalates at the critical ratio", () => {
    const s = classifyHeap(reading(4 * HEAP_CRITICAL_RATIO));
    expect(s.severity).toBe("critical");
    expect(s.message).toMatch(/critical/);
  });

  it("reports the real numbers in MB, matching the #121 crash", () => {
    // The reported crash: 4083 MB used against a ~4288 MB ceiling.
    const s = classifyHeap({ usedBytes: 4083 * 1_048_576, limitBytes: 4288 * 1_048_576 });
    expect(s.severity).toBe("critical");
    expect(s.message).toContain("4083 MB");
    expect(s.message).toContain("4288 MB");
  });

  it("does not divide by zero when no ceiling is reported", () => {
    const s = classifyHeap({ usedBytes: 5 * GB, limitBytes: 0 });
    expect(s.severity).toBe("ok");
    expect(s.ratio).toBe(0);
  });
});

describe("createHeapGuard", () => {
  it("reports each escalation once, not on every poll", () => {
    let used = 1;
    const guard = createHeapGuard(() => reading(used));
    expect(guard.check()).toBeNull(); // ok
    used = 3.2; // ~80% -> warn
    expect(guard.check()?.severity).toBe("warn");
    expect(guard.check()).toBeNull(); // still warn, stay quiet
    expect(guard.check()).toBeNull();
    used = 3.8; // ~95% -> critical
    expect(guard.check()?.severity).toBe("critical");
    expect(guard.check()).toBeNull();
  });

  it("re-arms after memory is released", () => {
    let used = 3.2;
    const guard = createHeapGuard(() => reading(used));
    expect(guard.check()?.severity).toBe("warn");
    used = 1; // recovered
    expect(guard.check()).toBeNull();
    used = 3.2; // climbs again -> warn again
    expect(guard.check()?.severity).toBe("warn");
  });
});

describe("readProcessHeap", () => {
  it("reads a real, sane ceiling from this process", () => {
    const r = readProcessHeap();
    expect(r.limitBytes).toBeGreaterThan(0);
    expect(r.usedBytes).toBeGreaterThan(0);
    expect(r.usedBytes).toBeLessThan(r.limitBytes);
  });
});
