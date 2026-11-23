import { describe, expect, it } from "vitest";

import { mergePolicySources } from "../policy/policy-loader.js";
import { parsePolicyFile } from "../policy/policy-schema.js";
import { policyCommand } from "./policy-command.js";

const policy = mergePolicySources([
  { status: { kind: "user", location: "/s/policy.json", state: "missing" } },
  {
    status: { kind: "system", location: "/etc/atomic-agent/policy.json", state: "loaded" },
    file: parsePolicyFile({
      rules: [{ action: "shell", resource: "rm *", effect: "deny", note: "ask IT" }],
      mcpAllowlist: { servers: ["github"], warnOnly: true },
    }),
  },
  { status: { kind: "url", location: "https://p.test/o.json?…", state: "cached", fetchedAt: "2026-11-17T00:00:00.000Z", error: "timeout" } },
]);

async function run(args: string[]) {
  let out = "";
  let err = "";
  const code = await policyCommand(args, {
    write: (t) => { out += t; },
    writeErr: (t) => { err += t; },
    load: async () => policy,
  });
  return { code, out, err };
}

describe("atag policy show (ATO-587)", () => {
  it("prints each source, the rules and the MCP allowlist", async () => {
    const { code, out } = await run(["show"]);
    expect(code).toBe(0);
    expect(out).toContain("user   missing     /s/policy.json");
    expect(out).toContain("system loaded      /etc/atomic-agent/policy.json");
    expect(out).toContain("url    cached      https://p.test/o.json?… (fetched 2026-11-17T00:00:00.000Z): timeout");
    expect(out).toContain('system policy rule 1: deny shell "rm *" (ask IT)');
    expect(out).toContain("MCP allowlist (system policy, warn only):");
    expect(out).toContain("  github");
  });

  it("--json prints the effective policy as data", async () => {
    const { code, out } = await run(["show", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out).rules[0]).toMatchObject({ action: "shell", effect: "deny", source: "system" });
  });

  it("rejects an unknown subcommand or option", async () => {
    expect((await run(["edit"])).code).toBe(2);
    expect((await run(["show", "--yaml"])).code).toBe(2);
    expect((await run(["--help"])).code).toBe(0);
  });
});
