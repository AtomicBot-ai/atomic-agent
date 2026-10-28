import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { ApprovalDeniedError } from "../../approval/dangerous-tool.js";
import { executeBatch, toBatchInputs } from "./batch-scheduler.js";

/**
 * Browser tools ask from inside a serialised group (they are class
 * `browser`, not `approval_gated`, so the step's approval barriers never
 * see them). A denial must still stop what was queued behind it.
 */
function ctx() {
  return { workingDir: "/tmp", sessionId: "s1", stepIndex: 0, signal: new AbortController().signal };
}

function registry(ran: string[], deny: ReadonlySet<string>): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of ["browser.type", "browser.click"]) {
    reg.register({
      name,
      description: name,
      readonly: false,
      run: async () => {
        if (deny.has(name)) throw new ApprovalDeniedError(name, undefined, { byUser: true });
        ran.push(name);
        return compressToolResult({ tool: name, status: "ok", output: "ok" });
      },
    });
  }
  return reg;
}

const BATCH = toBatchInputs([
  { tool: "browser.type", args: { ref: "e1", text: "hunter2" } },
  { tool: "browser.click", args: { ref: "e2" } },
]);

describe("serialised group after a denial", () => {
  it("[type password (denied), click Sign in] never clicks", async () => {
    const ran: string[] = [];
    const out = await executeBatch(BATCH, registry(ran, new Set(["browser.type"])), ctx());
    expect(ran).toEqual([]);
    expect(out.results[0]!.compressed?.details.errorName).toBe("ApprovalDeniedError");
    const second = out.results[1]!.compressed;
    expect(second?.status).toBe("error");
    expect(second?.details).toMatchObject({ notRun: true, blockedBy: "browser.type", blockedCause: "not_approved" });
  });

  it("an approved call lets the rest of the group run", async () => {
    const ran: string[] = [];
    await executeBatch(BATCH, registry(ran, new Set()), ctx());
    expect(ran).toEqual(["browser.type", "browser.click"]);
  });
});
