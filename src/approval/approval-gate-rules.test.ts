import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalGate, type ApprovalRequest } from "./approval-gate.js";
import {
  ApprovalRulesStore,
  getProjectApprovalRulesPath,
} from "./approval-rules-store.js";
import { runWithApprovalWorkdir } from "./approval-workdir.js";
import type { ApprovalLevel } from "./approval-level.js";

describe("ApprovalGate with saved rules (ATO-1141)", () => {
  let stateDir: string;
  let project: string;
  let store: ApprovalRulesStore;
  let emitted: ApprovalRequest[];

  function gate(level: ApprovalLevel = 1): ApprovalGate {
    const g = new ApprovalGate({ emit: (r) => emitted.push(r), level });
    g.setRules(store);
    return g;
  }

  function git(sub: string, extra: Partial<ApprovalRequest> = {}) {
    return {
      sessionId: "s",
      tool: "os.shell.run",
      category: "shell" as const,
      reason: "r",
      commandShape: "git",
      commandArgv: ["git", sub],
      workdir: project,
      ...extra,
    };
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "gate-rules-state-"));
    project = mkdtempSync(join(tmpdir(), "gate-rules-project-"));
    store = new ApprovalRulesStore({ stateDir });
    emitted = [];
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  describe("ruleDecisionFor", () => {
    it("reports a deny or ask rule without asking anyone", () => {
      store.add({ decision: "deny", commandPrefix: ["npm", "publish"], source: "user" });
      const g = gate();
      expect(
        g.ruleDecisionFor({
          sessionId: "s",
          tool: "os.shell.run",
          category: "shell",
          commandSegments: [["npm", "publish"]],
          workdir: project,
        }),
      ).toBe("deny");
      expect(emitted).toEqual([]);
    });

    it("a worker in a worktree is matched against its parent's project", () => {
      store.add({
        decision: "deny",
        commandPrefix: ["npm", "publish"],
        project,
        source: "user",
      });
      const g = gate();
      const check = {
        sessionId: "worker",
        tool: "os.shell.run",
        category: "shell" as const,
        commandSegments: [["npm", "publish"]],
        workdir: join(tmpdir(), "atag-fusion-x", "task"),
      };
      expect(g.ruleDecisionFor(check)).toBeNull();
      g.setSessionPolicy("worker", { onPrompt: "refuse", reason: "r", ruleWorkdir: project });
      expect(g.ruleDecisionFor(check)).toBe("deny");
    });
  });

  it("a deny rule refuses even at level 5, without a prompt", async () => {
    const rule = store.add({ decision: "deny", commandPrefix: ["git", "push"], source: "user" });
    const decision = await gate(5).request(git("push"));
    expect(decision.approved).toBe(false);
    expect(decision.automatic).toBe(true);
    expect(decision.reason).toBe(`blocked by your rule ${rule.id}: deny "git push"`);
    expect(emitted).toEqual([]);
  });

  it("a deny rule wins over a session grant", async () => {
    store.add({ decision: "deny", commandPrefix: ["git", "push"], source: "user" });
    const g = gate();
    const first = g.request(git("status"));
    g.resolve({ approvalId: emitted[0]!.approvalId, approved: true, grant: "shape" });
    await first;
    expect((await g.request(git("push"))).approved).toBe(false);
  });

  it("an ask rule prompts even where the level or a grant would not", async () => {
    store.add({ decision: "ask", commandPrefix: ["git", "push"], source: "user" });
    const g = gate(5);
    const pending = g.request(git("push"));
    expect(emitted).toHaveLength(1);
    g.resolve({ approvalId: emitted[0]!.approvalId, approved: true });
    expect((await pending).approved).toBe(true);
    // Other commands still ride the level.
    expect((await g.request(git("status"))).reason).toBe("auto-approved (level 5)");
  });

  it("an ask rule outranks an allow rule for the same command", async () => {
    store.add({ decision: "allow", commandPrefix: ["git"], source: "user" });
    store.add({ decision: "ask", commandPrefix: ["git", "push"], source: "user" });
    const g = gate();
    void g.request(git("push"));
    expect(emitted).toHaveLength(1);
    expect((await g.request(git("log"))).approved).toBe(true);
  });

  it("an allow rule runs the call unasked, after the level and the grants", async () => {
    const rule = store.add({
      decision: "allow",
      tool: "os.shell.run",
      category: "shell",
      commandPrefix: ["git", "status"],
      project,
      source: "prompt",
    });
    const g = gate();
    const decision = await g.request(git("status"));
    expect(decision).toMatchObject({ approved: true, reason: `auto-approved (rule ${rule.id})` });
    expect(emitted).toEqual([]);
    // The level still reports itself first where it already applies.
    expect((await gate(5).request(git("status"))).reason).toBe("auto-approved (level 5)");
  });

  it("an allow rule never silences a trust_config or state_secret request", async () => {
    store.add({ decision: "allow", tool: "os.fs.write", source: "user" });
    const g = gate();
    void g.request({
      sessionId: "s",
      tool: "os.fs.write",
      category: "trust_config",
      reason: "write config.json",
      workdir: project,
    });
    expect(emitted).toHaveLength(1);
  });

  it("a project-scoped allow does not apply in another project", async () => {
    store.add({ decision: "allow", commandPrefix: ["git", "status"], project, source: "prompt" });
    const elsewhere = mkdtempSync(join(tmpdir(), "gate-rules-elsewhere-"));
    try {
      const g = gate();
      void g.request(git("status", { workdir: elsewhere }));
      expect(emitted).toHaveLength(1);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("the model cannot grant itself an allow through the project file", async () => {
    // Level 2 lets the model write in the workspace unasked; an allow it
    // writes into the project's rules file must change nothing.
    mkdirSync(join(project, ".atomic-agent"), { recursive: true });
    writeFileSync(
      getProjectApprovalRulesPath(project),
      JSON.stringify({ version: 1, rules: [{ decision: "allow", category: "shell" }] }),
    );
    const g = gate(2);
    void g.request(git("push"));
    expect(emitted).toHaveLength(1);
  });

  it("a project file's deny applies to that project's sessions", async () => {
    mkdirSync(join(project, ".atomic-agent"), { recursive: true });
    writeFileSync(
      getProjectApprovalRulesPath(project),
      JSON.stringify({ version: 1, rules: [{ id: "r_nopush", decision: "deny", commandPrefix: ["git", "push"] }] }),
    );
    const decision = await gate(5).request(git("push"));
    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/r_nopush/);
  });

  it("reads the session folder from the dispatching tool call when the tool did not set it", async () => {
    store.add({ decision: "allow", commandPrefix: ["git", "status"], project, source: "prompt" });
    const g = gate();
    const request = git("status");
    delete (request as Partial<typeof request>).workdir;
    const decision = await runWithApprovalWorkdir(project, () => g.request(request));
    expect(decision.approved).toBe(true);
  });

  it('grant "always" saves an allow rule built from the pending request', async () => {
    const g = gate();
    const pending = g.request(git("status", { commandArgv: ["git", "status", "-s"] }));
    const request = emitted[0]!;
    expect(g.canGrantAlways(request)).toBe(true);
    expect(g.resolve({ approvalId: request.approvalId, approved: true, grant: "always" })).toBe(true);
    expect((await pending).approved).toBe(true);
    const saved = g.takeAlwaysRule(request.approvalId);
    expect(saved).toMatchObject({
      decision: "allow",
      tool: "os.shell.run",
      category: "shell",
      commandPrefix: ["git", "status"],
      project: store.canonicalDir(project),
      source: "prompt",
    });
    expect(g.takeAlwaysRule(request.approvalId)).toBeNull();
    expect(store.list()).toHaveLength(1);
    // The next `git status` in this project runs unasked, in any session.
    expect((await g.request(git("status", { sessionId: "other" }))).approved).toBe(true);
    expect(emitted).toHaveLength(1);
  });

  it('grant "always" on a denial or a non-grantable request saves nothing', async () => {
    const g = gate();
    void g.request(git("status"));
    g.resolve({ approvalId: emitted[0]!.approvalId, approved: false, grant: "always" });
    void g.request({
      sessionId: "s",
      tool: "os.fs.write",
      category: "trust_config",
      reason: "r",
      workdir: project,
    });
    const trust = emitted[1]!;
    expect(g.canGrantAlways(trust)).toBe(false);
    g.resolve({ approvalId: trust.approvalId, approved: true, grant: "always" });
    expect(store.list()).toEqual([]);
  });

  it("offers Allow always only with a rules store installed", () => {
    const bare = new ApprovalGate({ emit: () => undefined });
    const request = { ...git("status"), approvalId: "x" };
    expect(bare.canGrantAlways(request)).toBe(false);
    expect(gate().canGrantAlways(request)).toBe(true);
  });
});
