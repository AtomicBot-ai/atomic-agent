import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApprovalRule } from "../approval/approval-rules.js";
import {
  getApprovalRulesPath,
  getProjectApprovalRulesPath,
} from "../approval/approval-rules-store.js";

import { startTestHarness, type Harness } from "./test-harness.js";

interface ListBody {
  rules: ApprovalRule[];
  globalPath: string;
  projectPath?: string;
  projectRules: ApprovalRule[];
}

describe("/api/approval-rules (ATO-1141)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness({ approvalLevel: 1 });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("lists the global rules and the folder's project ask/deny rules", async () => {
    const store = harness.runtime.approvals.getRules()!;
    const saved = store.add({ decision: "deny", commandPrefix: ["rm"], source: "user" });
    mkdirSync(join(harness.workingDir, ".atomic-agent"), { recursive: true });
    writeFileSync(
      getProjectApprovalRulesPath(harness.workingDir),
      JSON.stringify({
        version: 1,
        rules: [
          { id: "r_ask", decision: "ask", commandPrefix: ["git", "push"] },
          { id: "r_self", decision: "allow", category: "shell" },
        ],
      }),
    );
    const params = new URLSearchParams({ workingDir: harness.workingDir });
    const response = await fetch(`${harness.baseUrl}/api/approval-rules?${params}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ListBody;
    expect(body.rules).toEqual([saved]);
    expect(body.globalPath).toBe(getApprovalRulesPath(harness.stateDir));
    expect(body.projectRules.map((r) => r.id)).toEqual(["r_ask"]);
    expect(body.projectPath).toMatch(/\.atomic-agent[\\/]approval-rules\.json$/);
  });

  it("deletes a global rule by id, 404 for an unknown one", async () => {
    const store = harness.runtime.approvals.getRules()!;
    const saved = store.add({ decision: "deny", commandPrefix: ["rm"], source: "user" });
    const missing = await fetch(`${harness.baseUrl}/api/approval-rules/r_nope`, { method: "DELETE" });
    expect(missing.status).toBe(404);
    const removed = await fetch(`${harness.baseUrl}/api/approval-rules/${saved.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true, id: saved.id });
    expect(store.list()).toEqual([]);
  });

  it("rejects a relative workingDir", async () => {
    const response = await fetch(`${harness.baseUrl}/api/approval-rules?workingDir=rel/dir`);
    expect(response.status).toBe(400);
  });
  describe("POST /api/approval-rules (ATO-1011)", () => {
    function post(body: unknown): Promise<Response> {
      return fetch(`${harness.baseUrl}/api/approval-rules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    }

    async function refusal(body: unknown): Promise<string> {
      const response = await post(body);
      expect(response.status).toBe(400);
      return ((await response.json()) as { error: { message: string } }).error.message;
    }

    it("saves a hand-made command rule in the global file", async () => {
      const response = await post({ decision: "allow", commandPrefix: ["git", "status"], note: "mine" });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { rule: ApprovalRule; created: boolean };
      expect(body.created).toBe(true);
      expect(body.rule).toMatchObject({
        decision: "allow",
        tool: "os.shell.run",
        category: "shell",
        commandPrefix: ["git", "status"],
        source: "user",
        note: "mine",
      });
      expect(body.rule.id).toMatch(/^r_/);
      const store = harness.runtime.approvals.getRules()!;
      expect(store.list()).toEqual([body.rule]);
      const again = await post({ decision: "allow", commandPrefix: ["git", "status"] });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ rule: body.rule, created: false });
    });

    it("saves a deny rule and a project-scoped ask rule", async () => {
      const deny = await post({ decision: "deny", commandPrefix: ["npm", "publish"] });
      expect(deny.status).toBe(201);
      const ask = await post({ decision: "ask", tool: "os.fs.write", project: harness.workingDir });
      expect(ask.status).toBe(201);
      expect(harness.runtime.approvals.getRules()!.list()).toHaveLength(2);
    });

    it("rejects a body the parser refuses with 400", async () => {
      expect(await refusal("{not json")).toBeTruthy();
      expect(await refusal([1])).toBe("body must be a JSON object");
      expect(await refusal({ decision: "maybe" })).toBe('decision must be "allow", "ask" or "deny"');
      expect(await refusal({ decision: "deny", path: "rel/dir" })).toBe("path must be an absolute path");
      expect(await refusal({ decision: "deny", prefix: ["rm"] })).toBe('unknown field "prefix"');
      expect(await refusal({ decision: "allow" })).toMatch(/must name a tool, a category or a commandPrefix/);
      expect(harness.runtime.approvals.getRules()!.list()).toEqual([]);
    });

    it("refuses an allow that \"Allow always\" would never save", async () => {
      expect(await refusal({ decision: "allow", category: "fs_write_home", tool: "os.fs.write" })).toMatch(
        /home folder/,
      );
      expect(await refusal({ decision: "allow", category: "state_secret" })).toMatch(/never allowed/);
      expect(await refusal({ decision: "allow", category: "trust_config" })).toMatch(/never allowed/);
      expect(await refusal({ decision: "allow", category: "shell_dangerous" })).toMatch(/never allowed/);
      expect(await refusal({ decision: "allow", category: "browser_commit" })).toMatch(/per site/);
      expect(await refusal({ decision: "allow", tool: "os.fs.write" })).toMatch(/must name a category/);
      expect(await refusal({ decision: "allow", category: "shell" })).toMatch(/needs a commandPrefix/);
      expect(await refusal({ decision: "allow", category: "fs_write_workspace" })).toMatch(/name the tool/);
      expect(await refusal({ decision: "allow", category: "http" })).toMatch(/needs an origin/);
      expect(await refusal({ decision: "allow", category: "fs_read_outside" })).toMatch(/needs a path/);
      expect(await refusal({ decision: "allow", commandPrefix: ["git", "push", "--force"] })).toMatch(
        /dangerous command/,
      );
      expect(await refusal({ decision: "allow", commandPrefix: ["rm", "-rf"] })).toMatch(
        /dangerous command|blocked by the shell guard/,
      );
      expect(await refusal({ decision: "allow", commandPrefix: ["sudo"] })).toMatch(/runs other commands/);
      expect(await refusal({ decision: "allow", commandPrefix: ["bash"] })).toMatch(/runs other commands/);
      expect(harness.runtime.approvals.getRules()!.list()).toEqual([]);
    });

    it("the gate applies the new rule from the next request", async () => {
      const gate = harness.runtime.approvals;
      const check = {
        sessionId: "s",
        tool: "os.shell.run",
        category: "shell" as const,
        commandArgv: ["git", "status"],
        commandSegments: [["git", "status"]],
        workdir: harness.workingDir,
      };
      expect(gate.ruleDecisionFor(check)).toBeNull();
      const response = await post({
        decision: "allow",
        commandPrefix: ["git", "status"],
        project: harness.workingDir,
      });
      const { rule } = (await response.json()) as { rule: ApprovalRule };
      expect(gate.ruleDecisionFor(check)).toBe("allow");
      const decision = await gate.request({ ...check, reason: "r", commandShape: "git" });
      expect(decision).toMatchObject({ approved: true, reason: `auto-approved (rule ${rule.id})` });
    });
  });
});
