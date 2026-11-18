import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mergePolicySources } from "../policy/policy-loader.js";
import { policyRuleMatch } from "../policy/policy-enforce.js";
import { parsePolicyFile } from "../policy/policy-schema.js";
import { ApprovalGate, type ApprovalRequest } from "./approval-gate.js";
import type { ApprovalLevel } from "./approval-level.js";
import { ApprovalRulesStore } from "./approval-rules-store.js";

describe("ApprovalGate with an organization policy (ATO-587)", () => {
  let stateDir: string;
  let store: ApprovalRulesStore;
  let emitted: ApprovalRequest[];

  const policy = mergePolicySources([{
    status: { kind: "system", location: "test", state: "loaded" },
    file: parsePolicyFile({
      rules: [
        { action: "shell", resource: "npm *", effect: "ask" },
        { action: "shell", resource: "rm *", effect: "deny" },
        { action: "edit", resource: "/etc/*", effect: "deny" },
      ],
    }),
  }]);

  function gate(level: ApprovalLevel): ApprovalGate {
    const g = new ApprovalGate({ emit: (r) => emitted.push(r), level });
    g.setRules(store);
    g.setOrgPolicy((request) => policyRuleMatch(policy, request));
    return g;
  }

  const shell = (argv: string[]) => ({
    sessionId: "s",
    tool: "os.shell.run",
    category: "shell" as const,
    reason: "r",
    commandArgv: argv,
    commandSegments: [argv],
  });

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "gate-org-policy-"));
    store = new ApprovalRulesStore({ stateDir });
    emitted = [];
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("a policy deny blocks even at full trust, without a prompt", async () => {
    const decision = await gate(5).request(shell(["rm", "-rf", "x"]));
    expect(decision.approved).toBe(false);
    expect(decision.automatic).toBe(true);
    expect(decision.reason).toContain("org-policy:system:2");
    expect(emitted).toHaveLength(0);
  });

  it("a policy deny blocks a file write the level would allow", async () => {
    const decision = await gate(5).request({
      sessionId: "s", tool: "os.fs.write", category: "fs_write_home", reason: "r", targetPaths: ["/etc/hosts"],
    });
    expect(decision.approved).toBe(false);
  });

  it("a policy ask prompts even at full trust and with a session grant", async () => {
    const g = gate(5);
    const pending = g.request(shell(["npm", "publish"]));
    await Promise.resolve();
    expect(emitted).toHaveLength(1);
    g.resolve({ approvalId: emitted[0]!.approvalId, approved: true });
    expect((await pending).approved).toBe(true);
  });

  it("a policy ask outranks the user's saved allow rule", async () => {
    store.add({ decision: "allow", commandPrefix: ["npm"], source: "user" });
    const g = gate(1);
    void g.request(shell(["npm", "i"]));
    await Promise.resolve();
    expect(emitted).toHaveLength(1);
  });

  it("the user's saved deny still wins over a policy ask", async () => {
    store.add({ decision: "deny", commandPrefix: ["npm"], source: "user" });
    const decision = await gate(5).request(shell(["npm", "i"]));
    expect(decision.approved).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  it("calls the policy does not name keep their normal path", async () => {
    const decision = await gate(5).request(shell(["ls"]));
    expect(decision.approved).toBe(true);
  });

  it("ruleDecisionFor and wouldPrompt see the policy", () => {
    const g = gate(5);
    expect(g.ruleDecisionFor(shell(["rm", "x"]))).toBe("deny");
    expect(g.ruleDecisionFor(shell(["npm", "i"]))).toBe("ask");
    expect(g.wouldPrompt("s", "shell", { tool: "os.shell.run", commandArgv: ["npm", "i"], commandSegments: [["npm", "i"]] })).toBe(true);
  });

  it("a policy check that throws never blocks a request", async () => {
    const g = new ApprovalGate({ emit: (r) => emitted.push(r), level: 5 });
    g.setOrgPolicy(() => {
      throw new Error("boom");
    });
    expect((await g.request(shell(["rm", "x"]))).approved).toBe(true);
  });
});
