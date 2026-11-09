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
});
