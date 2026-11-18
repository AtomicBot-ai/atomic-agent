import { describe, expect, it } from "vitest";

import { mcpServerPolicy, policyCallRefusal, policyRuleMatch, skillPolicyRefusal } from "./policy-enforce.js";
import type { EffectivePolicy } from "./policy-evaluator.js";
import { mergePolicySources } from "./policy-loader.js";
import { parsePolicyFile } from "./policy-schema.js";
import { gateRequestTarget, mcpResource, shellResources, toolCallTarget } from "./policy-targets.js";

function policyOf(raw: unknown): EffectivePolicy {
  return mergePolicySources([{ status: { kind: "system", location: "test", state: "loaded" }, file: parsePolicyFile(raw) }]);
}

describe("policy targets", () => {
  it("names an MCP tool as server/tool", () => {
    expect(mcpResource("mcp.github.create_issue")).toBe("github/create_issue");
    expect(mcpResource("os.shell.run")).toBeNull();
  });

  it("splits a command line into each command it runs", () => {
    expect(shellResources("cd /x && rm -rf  y; echo hi | sh")).toEqual([
      "cd /x && rm -rf y; echo hi | sh", "cd /x", "rm -rf y", "echo hi", "sh",
    ]);
  });

  it("reads a tool call's arguments", () => {
    expect(toolCallTarget("os.shell.run", { cmd: "git", args: ["push", "-f"] })).toEqual({ action: "shell", resources: ["git push -f"] });
    expect(toolCallTarget("os.shell.run", { wait: 3 })).toBeNull();
    expect(toolCallTarget("os.fs.move", { from: "/a", to: "/b" })).toEqual({ action: "edit", resources: ["/a", "/b"] });
    expect(toolCallTarget("os.web.fetch", { url: "https://x.test/" })).toEqual({ action: "webfetch", resources: ["https://x.test/"] });
    expect(toolCallTarget("os.web.search", { query: "q" })).toEqual({ action: "websearch", resources: ["q"] });
    expect(toolCallTarget("skill.view", { name: "notes" })).toEqual({ action: "skill", resources: ["notes"] });
    expect(toolCallTarget("skill.run_script", { skill: "notes", script: "a" })).toEqual({ action: "skill", resources: ["notes"] });
    expect(toolCallTarget("os.fs.read", { path: "/a" })).toBeNull();
  });

  it("reads an approval request's fields", () => {
    expect(gateRequestTarget({ tool: "os.shell.run", category: "shell", commandSegments: [["cd", "x"], ["rm", "-rf", "y"]] }))
      .toEqual({ action: "shell", resources: ["cd x", "rm -rf y"] });
    expect(gateRequestTarget({ tool: "os.fs.write", category: "fs_write_home", targetPaths: ["/h/a"], affectedResources: ["/h/a"] }))
      .toEqual({ action: "edit", resources: ["/h/a"] });
    expect(gateRequestTarget({ tool: "os.http.request", category: "http_write", affectedResources: ["https://x.test/a"], grantKey: "https://x.test" }))
      .toEqual({ action: "webfetch", resources: ["https://x.test/a", "https://x.test"] });
    expect(gateRequestTarget({ tool: "mcp.gh.delete_repo", category: "other" })).toEqual({ action: "mcp", resources: ["gh/delete_repo"] });
    expect(gateRequestTarget({ tool: "os.proc.kill", category: "proc_kill" })).toBeNull();
  });
});

describe("policyRuleMatch (approval gate)", () => {
  const policy = policyOf({
    rules: [
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status*", effect: "allow" },
      { action: "shell", resource: "rm *", effect: "deny", note: "ask IT" },
    ],
  });

  it("turns a deny into a deny rule naming the policy rule", () => {
    const match = policyRuleMatch(policy, { tool: "os.shell.run", category: "shell", commandSegments: [["cd", "x"], ["rm", "-rf", "y"]] });
    expect(match?.decision).toBe("deny");
    expect(match?.rule.id).toBe("org-policy:system:3");
    expect(match?.rule.note).toBe('system policy rule 3: deny shell "rm *" (ask IT)');
  });

  it("turns an ask into an ask rule", () => {
    expect(policyRuleMatch(policy, { tool: "os.shell.run", category: "shell", commandArgv: ["npm", "i"] })?.decision).toBe("ask");
  });

  it("an allow gives no rule: the user's own settings decide", () => {
    expect(policyRuleMatch(policy, { tool: "os.shell.run", category: "shell", commandArgv: ["git", "status"] })).toBeNull();
  });
});

describe("policyCallRefusal (dispatch)", () => {
  it("refuses a denied call of a tool that never asks the gate", () => {
    const policy = policyOf({ rules: [{ action: "websearch", resource: "*", effect: "deny" }] });
    const reason = policyCallRefusal(policy, "os.web.search", { query: "x" });
    expect(reason).toContain("os.web.search was not run: blocked by your organization's policy");
    expect(reason).toContain("do not retry");
  });

  it("lets an ask through to the tool's own approval", () => {
    const policy = policyOf({ rules: [{ action: "mcp", resource: "github/*", effect: "ask" }] });
    expect(policyCallRefusal(policy, "mcp.github.create_issue", {})).toBeNull();
  });

  it("does nothing with an empty policy", () => {
    expect(policyCallRefusal(policyOf({}), "os.shell.run", { cmd: "rm", args: ["-rf", "/"] })).toBeNull();
  });
});

// ATO-587 review: shell globs used to see only the raw line, so a full
// path, a nested shell or a script piped into sh walked past `rm *`.
describe("shell rules see each command the way saved rules do", () => {
  const policy = policyOf({ rules: [{ action: "shell", resource: "rm *", effect: "deny" }] });
  const refused = (cmd: string, args: string[] = []) => policyCallRefusal(policy, "os.shell.run", { cmd, args });

  it("reduces a full program path to its name", () => {
    expect(refused("/bin/rm", ["-rf", "x"])).not.toBeNull();
    expect(refused("/bin/rm -rf x")).not.toBeNull();
    expect(policyRuleMatch(policy, { tool: "os.shell.run", category: "shell", commandSegments: [["/bin/rm", "-rf", "x"]] })?.decision)
      .toBe("deny");
  });

  it("reads past wrappers and into nested shells on the dispatch path", () => {
    expect(refused("bash", ["-c", "rm -rf x"])).not.toBeNull();
    expect(refused("sudo rm -rf x")).not.toBeNull();
    expect(refused("env FOO=1 rm x")).not.toBeNull();
    expect(refused("FOO=1 rm x")).not.toBeNull();
    expect(refused("sleep 1 & rm x")).not.toBeNull();
    expect(refused("(rm -rf x)")).not.toBeNull();
  });

  it("treats a script piped into a shell as matching any shell deny or ask", () => {
    expect(refused("printf 'rm -rf x' | sh")).not.toBeNull();
    expect(policyRuleMatch(policy, {
      tool: "os.shell.run", category: "shell", commandSegments: [["printf", "x"], ["sh"]], commandUnreadable: true,
    })?.decision).toBe("deny");
    const ask = policyOf({ rules: [{ action: "shell", resource: "npm publish*", effect: "ask" }] });
    expect(policyRuleMatch(ask, {
      tool: "os.shell.run", category: "shell", commandSegments: [["curl", "x"], ["sh"]], commandUnreadable: true,
    })?.decision).toBe("ask");
  });

  it("leaves other commands alone", () => {
    expect(refused("ls", ["-la"])).toBeNull();
    expect(refused("echo rm")).toBeNull();
    expect(refused("printf 'hi' | cat")).toBeNull();
  });
});

describe("skills and MCP servers", () => {
  it("refuses a denied skill name", () => {
    const policy = policyOf({ rules: [{ action: "skill", resource: "publish-*", effect: "deny" }] });
    expect(skillPolicyRefusal(policy, "publish-site")).toContain('skill "publish-site" is blocked');
    expect(skillPolicyRefusal(policy, "notes")).toBeNull();
  });

  it("checks a stdio server by its command line and a remote one by URL", () => {
    const policy = policyOf({ mcpAllowlist: ["npx -y @corp/*", "https://mcp.corp.test/*"] });
    expect(mcpServerPolicy(policy, { name: "a", transport: { kind: "stdio", command: "npx", args: ["-y", "@corp/fs"] } }).allowed).toBe(true);
    expect(mcpServerPolicy(policy, { name: "b", transport: { kind: "streamable_http", url: "https://mcp.corp.test/mcp" } }).allowed).toBe(true);
    expect(mcpServerPolicy(policy, { name: "c", transport: { kind: "sse", url: "https://evil.test/sse" } }).allowed).toBe(false);
  });
});
