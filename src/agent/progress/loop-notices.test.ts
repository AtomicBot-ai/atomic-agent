import { describe, expect, it } from "vitest";
import * as publicLoop from "../loop-detector.js";
import * as notices from "./loop-notices.js";
import { runSyncLoopGate } from "../dispatch/batch-gates.js";
import { toBatchInputs } from "../batch-executor.js";
import { compressToolResult } from "../../compressor/result-compressor.js";

describe("loop guidance owner seams", () => {
  it("preserves all guidance function identities through the compatibility façade", () => {
    expect(publicLoop.formatRepeatNotice).toBe(notices.formatRepeatNotice); expect(publicLoop.formatVetoInstruction).toBe(notices.formatVetoInstruction);
    expect(publicLoop.formatTestRepeatNotice).toBe(notices.formatTestRepeatNotice); expect(publicLoop.formatOutcomeRepeatNotice).toBe(notices.formatOutcomeRepeatNotice);
    expect(publicLoop.formatReadRepeatNotice).toBe(notices.formatReadRepeatNotice); expect(publicLoop.formatWanderingRedirect).toBe(notices.formatWanderingRedirect);
    expect(publicLoop.formatForcedLoopReply).toBe(notices.formatForcedLoopReply); expect(publicLoop.extractLoopTarget).toBe(notices.extractLoopTarget);
  });

  it("keeps the full guidance in a real gate veto and grounds the forced reply in refused-call count", () => {
    const tracker = new publicLoop.ToolLoopTracker({ warningThreshold: 2, criticalThreshold: 2 });
    const input = toBatchInputs([{ tool: "os.web.fetch", args: { url: "https://user:secret@fixture.invalid/path?credential=hidden" } }])[0];
    if (!input) throw new Error("missing fixture call");
    for (let i = 0; i < 2; i++) { tracker.recordCall(input.call.tool, input.call.args); tracker.recordOutcome(input.call.tool, input.call.args, compressToolResult({ tool: input.call.tool, status: "ok", output: "same page" })); }
    const verdict = runSyncLoopGate(input, { workingDir: "/tmp", sessionId: "guidance", stepIndex: 0, signal: new AbortController().signal, tracker }, []);
    const summary = verdict.vetoResult?.summary;
    expect(summary).toContain("fixture.invalid"); expect(summary).not.toContain("secret"); expect(summary).not.toContain("credential");
    expect(summary).toContain("Do NOT repeat this exact call.");
    expect(notices.formatForcedLoopReply(input.call.tool, 2, "no_progress", tracker.vetoStreak(input.call.tool, input.call.args))).toContain("refused 1 time in a row");
    expect(notices.formatForcedLoopReply(input.call.tool, 12, "wandering", 1)).toContain("12, counting the last call, which was not run");
  });
});
