import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsShellTool } from "./shell.js";

/**
 * ATO-2529: a command the shell guard deems safe (`cat`, `echo`, `cp`)
 * never reached the gate, so the person's security rules never saw it:
 * "never read my notes" did not stop `cat notes.md`. Every call that
 * skips the gate is now reviewed when a guard file covers the shell.
 */
describe.skipIf(process.platform === "win32")("os.shell.run: security rules on commands the guard deems safe (ATO-2529)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-guard-safe-"));
    await writeFile(join(dir, "notes.md"), "private\n");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = (): ToolContext => ({ workingDir: dir, sessionId: "s1", stepIndex: 0, signal: new AbortController().signal });

  function gateWith(decision: "allow" | "block" | null, reviewed: string[]): ApprovalGate {
    const gate = new ApprovalGate({ level: 5, emit: () => undefined });
    gate.setGuard({
      rules: () => ({ sets: [{ source: "user", rules: "Never read notes.md." }], tools: new Set(["os.shell.run"]), onFailure: "block" }),
      review: async (request) => {
        reviewed.push(request.preview ?? "");
        return decision === null ? null : { decision, reason: decision === "block" ? "reads notes.md" : "" };
      },
    });
    return gate;
  }

  it("a block refuses a safe command in bypass", async () => {
    const reviewed: string[] = [];
    const tool = buildOsShellTool({ approvals: gateWith("block", reviewed), approvalRequired: true });
    await expect(tool.run({ cmd: "cat", args: ["notes.md"] }, ctx())).rejects.toMatchObject({
      name: "ApprovalDeniedError",
      byUser: false,
      message: expect.stringContaining("Blocked by your security rules: reads notes.md"),
    });
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]).toContain("notes.md");
  });

  it("an allow runs it, and without a guard file nothing is reviewed", async () => {
    const reviewed: string[] = [];
    const allowed = buildOsShellTool({ approvals: gateWith("allow", reviewed), approvalRequired: true });
    expect((await allowed.run({ cmd: "cat", args: ["notes.md"] }, ctx())).status).toBe("ok");
    const plain = buildOsShellTool({ approvals: new ApprovalGate({ level: 5, emit: () => undefined }), approvalRequired: true });
    expect((await plain.run({ cmd: "cat", args: ["notes.md"] }, ctx())).status).toBe("ok");
    expect(reviewed).toHaveLength(1);
  });

  it("a reviewer that gives no answer under onFailure: block refuses it", async () => {
    const tool = buildOsShellTool({ approvals: gateWith(null, []), approvalRequired: true });
    await expect(tool.run({ cmd: "echo", args: ["hi"] }, ctx())).rejects.toMatchObject({ name: "ApprovalDeniedError" });
  });
});
