import { describe, expect, it } from "vitest";

import { evaluatePolicy, mcpServerVerdict, type EffectivePolicy, type PolicySourceKind } from "./policy-evaluator.js";
import { globMatches } from "./policy-glob.js";
import { mergePolicySources } from "./policy-loader.js";
import { parsePolicyFile, PolicyFormatError } from "./policy-schema.js";

function policyOf(raw: unknown, kind: PolicySourceKind = "system"): EffectivePolicy {
  return mergePolicySources([{ status: { kind, location: "test", state: "loaded" }, file: parsePolicyFile(raw) }]);
}

describe("globMatches", () => {
  it("* spans any characters including slashes, ? is one character, the rest is literal", () => {
    expect(globMatches("rm *", "rm -rf /tmp/x")).toBe(true);
    expect(globMatches("rm *", "rmdir x")).toBe(false);
    expect(globMatches("https://*.example.com/*", "https://api.example.com/v1/x")).toBe(true);
    expect(globMatches("https://*.example.com/*", "https://example.org/")).toBe(false);
    expect(globMatches("file?.txt", "file1.txt")).toBe(true);
    expect(globMatches("file?.txt", "file12.txt")).toBe(false);
    expect(globMatches("a.b", "aXb")).toBe(false);
    expect(globMatches("(x)+[y]", "(x)+[y]")).toBe(true);
  });

  it("matches the whole string, not a part of it", () => {
    expect(globMatches("git", "git status")).toBe(false);
    expect(globMatches("*", "")).toBe(true);
  });
});

describe("evaluatePolicy", () => {
  it("the last matching rule wins between allow and ask", () => {
    const policy = policyOf({
      rules: [
        { action: "shell", resource: "*", effect: "ask" },
        { action: "shell", resource: "git *", effect: "allow" },
      ],
    });
    expect(evaluatePolicy(policy, "shell", ["git status"])?.effect).toBe("allow");
    expect(evaluatePolicy(policy, "shell", ["npm publish"])?.effect).toBe("ask");
  });

  it("a later allow never beats an earlier deny", () => {
    const policy = policyOf({
      rules: [
        { action: "shell", resource: "rm *", effect: "deny" },
        { action: "shell", resource: "*", effect: "allow" },
      ],
    });
    const verdict = evaluatePolicy(policy, "shell", ["rm -rf /"]);
    expect(verdict?.effect).toBe("deny");
    expect(verdict?.rule.index).toBe(0);
  });

  it("rules only apply to their own action", () => {
    const policy = policyOf({ rules: [{ action: "edit", resource: "*", effect: "deny" }] });
    expect(evaluatePolicy(policy, "shell", ["ls"])).toBeNull();
    expect(evaluatePolicy(policy, "edit", ["/etc/hosts"])?.effect).toBe("deny");
  });

  it("over several resources the strictest answer wins", () => {
    const policy = policyOf({
      rules: [
        { action: "shell", resource: "cd *", effect: "allow" },
        { action: "shell", resource: "curl *", effect: "ask" },
        { action: "shell", resource: "rm *", effect: "deny" },
      ],
    });
    expect(evaluatePolicy(policy, "shell", ["cd x", "curl y"])?.effect).toBe("ask");
    expect(evaluatePolicy(policy, "shell", ["cd x", "rm -rf y", "curl z"])?.effect).toBe("deny");
  });

  it("returns null when nothing matches", () => {
    const policy = policyOf({ rules: [{ action: "skill", resource: "publish-*", effect: "deny" }] });
    expect(evaluatePolicy(policy, "skill", ["notes"])).toBeNull();
  });

  it("a deny from a weaker source still wins over a stronger source's allow", () => {
    const policy = mergePolicySources([
      { status: { kind: "user", location: "u", state: "loaded" }, file: parsePolicyFile({ rules: [{ action: "websearch", resource: "*secret*", effect: "deny" }] }) },
      { status: { kind: "url", location: "x", state: "loaded" }, file: parsePolicyFile({ rules: [{ action: "websearch", resource: "*", effect: "allow" }] }) },
    ]);
    expect(evaluatePolicy(policy, "websearch", ["the secret plan"])?.rule.source).toBe("user");
  });

  it("an allow in one source never cancels another source's ask", () => {
    const policy = mergePolicySources([
      { status: { kind: "system", location: "s", state: "loaded" }, file: parsePolicyFile({ rules: [{ action: "shell", resource: "*", effect: "ask" }] }) },
      { status: { kind: "url", location: "x", state: "loaded" }, file: parsePolicyFile({ rules: [{ action: "shell", resource: "*", effect: "allow" }] }) },
    ]);
    expect(evaluatePolicy(policy, "shell", ["ls"])?.effect).toBe("ask");
  });
});

describe("parsePolicyFile", () => {
  it("defaults the resource to * and accepts a bare array as the allowlist", () => {
    const file = parsePolicyFile({ rules: [{ action: "mcp", effect: "deny" }], mcpAllowlist: ["github"] });
    expect(file.rules[0]).toEqual({ action: "mcp", resource: "*", effect: "deny" });
    expect(file.mcpAllowlist).toEqual({ servers: ["github"], warnOnly: false });
  });

  it("rejects unknown actions, effects and versions", () => {
    expect(() => parsePolicyFile({ rules: [{ action: "browse", effect: "deny" }] })).toThrow(PolicyFormatError);
    expect(() => parsePolicyFile({ rules: [{ action: "shell", effect: "maybe" }] })).toThrow(/rules\[0\]\.effect/);
    expect(() => parsePolicyFile({ version: 2 })).toThrow(/version/);
    expect(() => parsePolicyFile({ mcpAllowlist: { servers: [1] } })).toThrow(/mcpAllowlist/);
  });
});

describe("mcpServerVerdict", () => {
  it("allows every server when there is no allowlist", () => {
    expect(mcpServerVerdict(policyOf({}), { name: "anything" })).toEqual({ allowed: true });
  });

  it("matches the name, the URL or the command", () => {
    const policy = policyOf({ mcpAllowlist: { servers: ["github", "https://mcp.example.com/*", "npx -y @acme/*"] } });
    expect(mcpServerVerdict(policy, { name: "github" }).allowed).toBe(true);
    expect(mcpServerVerdict(policy, { name: "x", url: "https://mcp.example.com/mcp" }).allowed).toBe(true);
    expect(mcpServerVerdict(policy, { name: "y", command: "npx -y @acme/server" }).allowed).toBe(true);
    const refused = mcpServerVerdict(policy, { name: "evil", url: "https://evil.test/mcp" });
    expect(refused.allowed).toBe(false);
    expect(refused.message).toContain('"evil" is not on your organization\'s allowlist');
  });

  it("a server must be on every source's allowlist", () => {
    const policy = mergePolicySources([
      { status: { kind: "system", location: "s", state: "loaded" }, file: parsePolicyFile({ mcpAllowlist: ["github", "linear"] }) },
      { status: { kind: "url", location: "x", state: "loaded" }, file: parsePolicyFile({ mcpAllowlist: ["*"] }) },
      { status: { kind: "user", location: "u", state: "loaded" }, file: parsePolicyFile({ mcpAllowlist: { servers: ["github"], warnOnly: true } }) },
    ]);
    expect(mcpServerVerdict(policy, { name: "github" })).toEqual({ allowed: true });
    // Only the warn-only list misses linear: it connects, with a warning.
    expect(mcpServerVerdict(policy, { name: "linear" }).allowed).toBe(true);
    expect(mcpServerVerdict(policy, { name: "linear" }).message).toContain("warn-only");
    // The system list misses evil: refused, whatever the other lists say.
    expect(mcpServerVerdict(policy, { name: "evil" })).toMatchObject({ allowed: false });
  });

  it("warn-only mode lets an unlisted server through with a message", () => {
    const policy = policyOf({ mcpAllowlist: { servers: [], warnOnly: true } });
    const verdict = mcpServerVerdict(policy, { name: "evil" });
    expect(verdict.allowed).toBe(true);
    expect(verdict.message).toContain("warn-only");
  });
});
