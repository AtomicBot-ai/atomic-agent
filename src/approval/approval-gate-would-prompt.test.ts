import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalGate, type ApprovalRequest } from "./approval-gate.js";
import { runWithApprovalLedger, type ToolApprovalRecord } from "./approval-ledger.js";
import { ApprovalRulesStore } from "./approval-rules-store.js";
import type { ApprovalLevel } from "./approval-level.js";

/**
 * ATO-1270: `wouldPrompt` (the fan-out's pre-check) reads saved rules
 * the way `request` does, and an allow rule's auto-approval lands in
 * the tool call's approval ledger.
 */
describe("ApprovalGate.wouldPrompt with saved rules (ATO-1270)", () => {
  let stateDir: string;
  let project: string;
  let store: ApprovalRulesStore;
  let emitted: ApprovalRequest[];

  function gate(level: ApprovalLevel = 1): ApprovalGate {
    const g = new ApprovalGate({ emit: (r) => emitted.push(r), level });
    g.setRules(store);
    return g;
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "would-prompt-state-"));
    project = mkdtempSync(join(tmpdir(), "would-prompt-project-"));
    store = new ApprovalRulesStore({ stateDir });
    emitted = [];
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("without rules it still follows the level", () => {
    expect(gate(1).wouldPrompt("s", "shell")).toBe(true);
    expect(gate(5).wouldPrompt("s", "shell")).toBe(false);
  });

  it("an allow rule means no prompt", () => {
    store.add({ decision: "allow", tool: "os.fs.write", category: "fs_write_workspace", source: "user" });
    const g = gate(1);
    expect(g.wouldPrompt("s", "fs_write_workspace", { tool: "os.fs.write", workdir: project })).toBe(false);
    // Another tool is not covered.
    expect(g.wouldPrompt("s", "fs_write_workspace", { tool: "os.fs.patch", workdir: project })).toBe(true);
  });

  it("a deny rule means no prompt: the call is refused unasked", async () => {
    store.add({ decision: "deny", tool: "fusion.delegate", source: "user" });
    const g = gate(1);
    expect(g.wouldPrompt("s", "fusion_fanout", { tool: "fusion.delegate", workdir: project })).toBe(false);
    await expect(
      g.request({ sessionId: "s", tool: "fusion.delegate", category: "fusion_fanout", reason: "r", workdir: project }),
    ).resolves.toMatchObject({ approved: false, automatic: true });
    expect(emitted).toEqual([]);
  });

  it("an ask rule prompts even where the level would run the call", () => {
    store.add({ decision: "ask", tool: "fusion.delegate", source: "user" });
    const g = gate(5);
    expect(g.wouldPrompt("s", "fusion_fanout", { tool: "fusion.delegate", workdir: project })).toBe(true);
    // Without the tool named, the tool-scoped rule cannot match.
    expect(g.wouldPrompt("s", "fusion_fanout", { workdir: project })).toBe(false);
  });

  it("an ask rule prompts past a session grant", async () => {
    store.add({ decision: "ask", category: "http", source: "user" });
    const g = new ApprovalGate({
      level: 1,
      emit: (r) => {
        emitted.push(r);
        g.resolve({ approvalId: r.approvalId, approved: true, grant: "category" });
      },
    });
    await g.request({ sessionId: "s", tool: "web.fetch", category: "http", reason: "r" });
    expect(g.sessionGrants("s").categories).toEqual(["http"]);
    expect(g.wouldPrompt("s", "http")).toBe(false);
    g.setRules(store);
    expect(g.wouldPrompt("s", "http", { tool: "web.fetch", workdir: project })).toBe(true);
  });

  it("an allow rule never covers a category that is never granted", () => {
    store.add({ decision: "allow", category: "trust_config", source: "user" });
    expect(gate(1).wouldPrompt("s", "trust_config", { workdir: project })).toBe(true);
  });

  it("a refuse policy still answers for the session", () => {
    const g = gate(1);
    g.setSessionPolicy("worker", { onPrompt: "refuse", reason: "no person here" });
    expect(g.wouldPrompt("worker", "shell")).toBe(false);
  });

  it("asks nothing and records nothing", async () => {
    store.add({ decision: "allow", tool: "os.fs.write", category: "fs_write_workspace", source: "user" });
    const g = gate(1);
    const ledger: ToolApprovalRecord[] = [];
    await runWithApprovalLedger(ledger, async () => {
      g.wouldPrompt("s", "fs_write_workspace", { tool: "os.fs.write", workdir: project });
    });
    expect(ledger).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("a call an allow rule approves is logged in the call's ledger", async () => {
    const rule = store.add({
      decision: "allow",
      tool: "os.fs.write",
      category: "fs_write_workspace",
      source: "user",
    });
    const g = gate(1);
    const ledger: ToolApprovalRecord[] = [];
    const decision = await runWithApprovalLedger(ledger, () =>
      g.request({
        sessionId: "s",
        tool: "os.fs.write",
        category: "fs_write_workspace",
        reason: "r",
        workdir: project,
      }),
    );
    expect(decision.approved).toBe(true);
    expect(emitted).toEqual([]);
    expect(ledger).toEqual([
      expect.objectContaining({
        verdict: "auto-approved",
        via: "rule",
        category: "fs_write_workspace",
        reason: expect.stringContaining(`rule ${rule.id}`),
      }),
    ]);
  });
});
