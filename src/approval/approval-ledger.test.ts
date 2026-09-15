import { describe, expect, it } from "vitest";

import { executeBatch, toBatchInputs } from "../agent/batch-executor.js";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../compressor/result-compressor.js";
import { toolResultTurn } from "../session/conversation-turn.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { ApprovalGate, type ApprovalRequest } from "./approval-gate.js";
import {
  currentApprovalLedger,
  runWithApprovalLedger,
  type ToolApprovalRecord,
} from "./approval-ledger.js";
import { ApprovalDeniedError, requireApproval } from "./dangerous-tool.js";

function gatedRegistry(gate: ApprovalGate): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "os.fs.read",
    description: "a read that asks first (test double)",
    readonly: true,
    async run(args, ctx): Promise<CompressedToolResult> {
      try {
        await requireApproval(
          { approvals: gate, approvalRequired: true },
          {
            sessionId: ctx.sessionId,
            tool: "os.fs.read",
            category: "shell",
            reason: "test",
            preview: String(args.label),
          },
          ctx.signal,
        );
      } catch (err) {
        if (err instanceof ApprovalDeniedError) {
          return compressToolResult({ tool: "os.fs.read", status: "error", output: err.message });
        }
        throw err;
      }
      return compressToolResult({ tool: "os.fs.read", status: "ok", output: `ran ${String(args.label)}` });
    },
  });
  return registry;
}

function batchCtx() {
  return { workingDir: "/tmp", sessionId: "s1", stepIndex: 0, signal: new AbortController().signal };
}

describe("approval ledger", () => {
  it("is empty outside a tool call and scoped to the call inside one", async () => {
    expect(currentApprovalLedger()).toBeUndefined();
    const ledger: ToolApprovalRecord[] = [];
    await runWithApprovalLedger(ledger, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(currentApprovalLedger()).toBe(ledger);
    });
    expect(currentApprovalLedger()).toBeUndefined();
  });

  /* The verdicts arrive from somewhere else entirely (an HTTP handler),
     in the opposite order the calls asked, while both calls of the SAME
     tool are waiting. Each result must still carry its own verdict. */
  it("stamps each concurrent call of a batch with its own verdict", async () => {
    const gate: ApprovalGate = new ApprovalGate({
      emit: (req: ApprovalRequest) => {
        const approved = req.preview === "A";
        setTimeout(
          () => gate.resolve({ approvalId: req.approvalId, approved }),
          approved ? 40 : 5,
        );
      },
    });
    const outcome = await executeBatch(
      toBatchInputs([
        { tool: "os.fs.read", args: { label: "A" } },
        { tool: "os.fs.read", args: { label: "B" } },
      ]),
      gatedRegistry(gate),
      batchCtx(),
    );
    const [a, b] = outcome.results.map((slot) => slot.compressed!);
    expect(a!.status).toBe("ok");
    expect(a!.approvals?.map((r) => [r.verdict, r.category])).toEqual([["approved", "shell"]]);
    expect(b!.status).toBe("error");
    expect(b!.approvals?.map((r) => [r.verdict, r.category])).toEqual([["denied", "shell"]]);
    expect(typeof a!.approvals![0]!.at).toBe("number");
  });

  it("records nothing for a request nobody was asked (auto-approved)", async () => {
    const gate = new ApprovalGate({ emit: () => { throw new Error("must not prompt"); }, level: 5 });
    const outcome = await executeBatch(
      toBatchInputs([{ tool: "os.fs.read", args: { label: "A" } }]),
      gatedRegistry(gate),
      batchCtx(),
    );
    const result = outcome.results[0]!.compressed!;
    expect(result.status).toBe("ok");
    expect(result).not.toHaveProperty("approvals");
  });

  it("carries the verdicts onto the transcript's tool_result row", () => {
    const approvals: ToolApprovalRecord[] = [{ verdict: "approved", category: "shell", at: 1 }];
    expect(toolResultTurn({ tool: "os.shell.run", status: "ok", summary: "ok", approvals, at: 2 }))
      .toEqual({ kind: "tool_result", tool: "os.shell.run", status: "ok", summary: "ok", approvals, at: 2 });
    expect(toolResultTurn({ tool: "os.shell.run", status: "ok", summary: "ok", approvals: [], at: 2 }))
      .not.toHaveProperty("approvals");
  });
});
