import { describe, expect, it } from "vitest";
import { createTraceRecorder } from "./trace-recorder.js";
import type { TraceEvent } from "./trace-event.js";

/**
 * ATO-2529: a call the security rules refused showed in the trace only as
 * an error summary. The tool result's approvals, the `guard` record
 * included, now reach the `tool_invocation` row.
 */
describe("trace tool_invocation approvals (ATO-2529)", () => {
  function run(approvals: unknown[] | undefined): TraceEvent | undefined {
    const events: TraceEvent[] = [];
    const rec = createTraceRecorder({ sessionId: "s-guard", emit: (e) => events.push(e), now: () => 1, knownSecrets: () => [] });
    rec.onAgentEvent({ type: "turn_started", turnIndex: 0 });
    rec.onAgentEvent({ type: "step_started", stepIndex: 0 });
    rec.onAgentEvent({
      type: "llm_event",
      event: { type: "tool_call_parsed", call: { tool: "os.shell.run", args: { cmd: "cat notes" } }, batchIndex: 0, batchSize: 1 },
    });
    rec.onAgentEvent({
      type: "llm_event",
      event: {
        type: "tool_call_executed",
        result: {
          tool: "os.shell.run",
          status: "error",
          summary: "Blocked by your security rules: reads private notes",
          truncated: false,
          ...(approvals !== undefined ? { approvals } : {}),
        },
        batchIndex: 0,
        batchSize: 1,
      },
    } as never);
    return events.find((e) => e.type === "tool_invocation");
  }

  it("carries a security rules refusal", () => {
    const guard = { verdict: "denied", category: "shell", at: 5, guard: { decision: "block", reason: "reads private notes" } };
    expect(run([guard])).toMatchObject({ approvals: [guard] });
  });

  it("leaves the field out when the call raised no approval", () => {
    const row = run(undefined);
    expect(row && "approvals" in row).toBe(false);
  });
});
