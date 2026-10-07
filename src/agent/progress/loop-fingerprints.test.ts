import { describe, expect, it } from "vitest";
import { compressToolResult } from "../../compressor/result-compressor.js";
import * as publicLoop from "../loop-detector.js";
import * as fingerprints from "./loop-fingerprints.js";
import { LOOP_VETO_DENIED_REASON } from "./loop-constants.js";

const result = (summary: string, details: Record<string, unknown> = {}) => compressToolResult({ tool: "os.web.fetch", status: "ok", output: summary, details });
describe("deterministic progress owner compatibility", () => {
  it("keeps every prior fingerprint export as the same function and leaves internal helpers off the old public façade", () => {
    expect(publicLoop.fingerprintToolOutcome).toBe(fingerprints.fingerprintToolOutcome);
    expect(publicLoop.hashToolCall).toBe(fingerprints.hashToolCall); expect(publicLoop.hashToolOutcome).toBe(fingerprints.hashToolOutcome);
    expect(publicLoop.isSuccessfulWrite).toBe(fingerprints.isSuccessfulWrite); expect(publicLoop.isLoopVetoResult).toBe(fingerprints.isLoopVetoResult);
    expect(Object.keys(publicLoop)).not.toContain("hashBatchCompositeArgs"); expect(Object.keys(publicLoop)).not.toContain("sameReadVersion");
  });

  it("feeds one tracker semantic hashes across volatile details and resets outcome repetition after an actual successful-write observation", () => {
    const tracker = new publicLoop.ToolLoopTracker(); const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const args = { url: `https://fixture.invalid/${i}` }; const observed = result("same body", { requestId: String(i), nested: { timestamp: i, stable: "same" } });
      tracker.recordCall("os.web.fetch", args); counts.push(tracker.recordOutcome("os.web.fetch", args, observed).count);
    }
    expect(counts).toEqual([1, 2, 3]);
    expect(fingerprints.hashToolOutcome("os.web.fetch", {}, result("same body", { nested: { stable: "same" }, requestId: "first" }))).toBe(fingerprints.hashToolOutcome("os.web.fetch", {}, result("same body", { requestId: "later", nested: { timestamp: 99, stable: "same" } })));
    tracker.recordCall("os.fs.write", { path: "fixture" }); tracker.recordOutcome("os.fs.write", { path: "fixture" }, compressToolResult({ tool: "os.fs.write", status: "ok", output: "written" }));
    expect(tracker.recordOutcome("os.web.fetch", {}, result("same body")).count).toBe(1);
    const veto = compressToolResult({ tool: "os.web.fetch", status: "error", output: "blocked", details: { deniedReason: LOOP_VETO_DENIED_REASON } });
    expect(fingerprints.hashToolOutcome("os.web.fetch", {}, veto)).toBeUndefined();
  });

  it("uses the internal read-version helper without detaching read coverage from tracker state", () => {
    const tracker = new publicLoop.ToolLoopTracker();
    const read = { path: "/fixture", contentHash: "v1", span: { start: 1, end: 5 }, totalLines: 10, numbered: true, truncated: false };
    tracker.recordRead(read); expect(tracker.checkReadRepeat(read).covered).toBe("1-5");
    expect(tracker.checkReadRepeat({ ...read, numbered: false }).repeat).toBe(false);
    tracker.recordRead({ ...read, numbered: false, span: { start: 6, end: 10 } });
    expect(tracker.checkReadRepeat({ ...read, numbered: false, span: { start: 6, end: 10 } }).covered).toBe("6-10");
    expect(fingerprints.hashToolCall("fixture", { a: 1, b: 2 })).toBe(fingerprints.hashToolCall("fixture", { b: 2, a: 1 }));
    expect(fingerprints.hashBatchCompositeArgs([{ tool: "a", args: {} }, { tool: "b", args: {} }])).not.toBe(fingerprints.hashBatchCompositeArgs([{ tool: "b", args: {} }, { tool: "a", args: {} }]));
  });
});
