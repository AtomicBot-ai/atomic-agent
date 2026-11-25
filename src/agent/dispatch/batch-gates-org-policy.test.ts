import { describe, expect, it } from "vitest";

import { mergePolicySources } from "../../policy/policy-loader.js";
import { EMPTY_POLICY } from "../../policy/policy-evaluator.js";
import { parsePolicyFile } from "../../policy/policy-schema.js";
import { refuseByOrgPolicy } from "./batch-gates.js";

const policy = mergePolicySources([{
  status: { kind: "url", location: "https://policy.test/p.json", state: "loaded" },
  file: parsePolicyFile({
    rules: [
      { action: "websearch", resource: "*", effect: "deny" },
      { action: "shell", resource: "rm *", effect: "deny" },
      { action: "mcp", resource: "github/*", effect: "ask" },
    ],
  }),
}]);

describe("refuseByOrgPolicy (ATO-587)", () => {
  it("refuses a denied call of a tool that never asks the approval gate", () => {
    const result = refuseByOrgPolicy({ tool: "os.web.search", args: { query: "x" } }, policy);
    expect(result?.status).toBe("error");
    expect(result?.summary).toContain("blocked by your organization's policy");
    expect(result?.details).toMatchObject({ policyDenied: true });
  });

  it("refuses a denied command hidden in a compound line", () => {
    expect(refuseByOrgPolicy({ tool: "os.shell.run", args: { cmd: "cd /tmp && rm -rf x" } }, policy)).not.toBeNull();
  });

  it("leaves an ask to the tool's approval and other calls alone", () => {
    expect(refuseByOrgPolicy({ tool: "mcp.github.create_issue", args: {} }, policy)).toBeNull();
    expect(refuseByOrgPolicy({ tool: "os.shell.run", args: { cmd: "ls" } }, policy)).toBeNull();
    expect(refuseByOrgPolicy({ tool: "os.web.search", args: { query: "x" } }, EMPTY_POLICY)).toBeNull();
  });
});
