import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import { buildMcpServeTools } from "./mcp-server-tools.js";
import { createMcpServeServer, MCP_SERVE_REFUSAL } from "./mcp-server-bridge.js";
import { buildMcpServeApprovals } from "./mcp-server-command.js";
import { mergePolicySources } from "../policy/policy-loader.js";
import { parsePolicyFile } from "../policy/policy-schema.js";
import type { EffectivePolicy } from "../policy/policy-evaluator.js";

const noSkills = {
  list: () => [],
  get: () => undefined,
  readBody: async () => "",
} as unknown as SkillRegistry;

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");
}

describe("buildMcpServeApprovals (ATO-549)", () => {
  let tmp: string;
  let client: Client | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-mcp-serve-command-"));
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  // The gate the command builds must refuse a prompt on its own: with no
  // refuse policy the call would wait for an answer nobody can give.
  it.skipIf(process.platform === "win32")(
    "refuses a shell command at level 1 straight away instead of waiting on a prompt",
    async () => {
      const approvals = buildMcpServeApprovals({
        agent: { approvalLevel: 1 },
        paths: { stateDir: tmp },
      });
      const toolSet = buildMcpServeTools(
        { allowWrite: false, allowExec: true, tools: [] },
        {
          notesRecallDefaultK: 5,
          notesMaxContentChars: 2000,
          skillRegistry: noSkills,
          approvals,
        },
      );
      const server = createMcpServeServer({ toolSet, workingDir: tmp, version: "0.0.0-test" });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      client = new Client({ name: "test-client", version: "1.0.0" });
      await client.connect(clientSide);

      const target = join(tmp, "x");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 1000);
      });
      const outcome = await Promise.race([
        client.callTool({ name: "os_shell_run", arguments: { cmd: "touch", args: [target] } }),
        timedOut,
      ]);
      clearTimeout(timer);

      expect(outcome).not.toBe("timeout");
      if (outcome === "timeout") return;
      expect(outcome.isError).toBe(true);
      expect(text(outcome)).toContain(MCP_SERVE_REFUSAL);
      expect(existsSync(target)).toBe(false);
    },
    5000,
  );
});

// ATO-587 review: `mcp-server --allow-exec` serves os.shell.run outside
// the runtime, so it must apply the admin policy itself, at the gate and
// before the call (for commands the guard deems safe, which never ask).
describe("mcp-server under an organization policy (ATO-587)", () => {
  let tmp: string;
  let client: Client | undefined;

  function systemPolicy(rules: unknown[]): EffectivePolicy {
    return mergePolicySources([{
      status: { kind: "system", location: "test", state: "loaded" },
      file: parsePolicyFile({ rules }),
    }]);
  }

  async function connect(policy: EffectivePolicy, level: 1 | 5): Promise<Client> {
    const approvals = buildMcpServeApprovals(
      { agent: { approvalLevel: level }, paths: { stateDir: tmp } },
      () => undefined,
      () => policy,
    );
    const toolSet = buildMcpServeTools(
      { allowWrite: false, allowExec: true, tools: [] },
      { notesRecallDefaultK: 5, notesMaxContentChars: 2000, skillRegistry: noSkills, approvals },
    );
    const server = createMcpServeServer({ toolSet, workingDir: tmp, version: "0.0.0-test", orgPolicy: () => policy });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientSide);
    return client;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-mcp-serve-policy-"));
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("refuses a denied command before it runs, even at full trust", async () => {
    const c = await connect(systemPolicy([{ action: "shell", resource: "touch *", effect: "deny" }]), 5);
    const target = join(tmp, "denied");
    const result = await c.callTool({ name: "os_shell_run", arguments: { cmd: "touch", args: [target] } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("organization's policy");
    expect(existsSync(target)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("refuses a command the policy says to ask about, since nobody can answer", async () => {
    const c = await connect(systemPolicy([{ action: "shell", resource: "touch *", effect: "ask" }]), 5);
    const target = join(tmp, "asked");
    const result = await c.callTool({ name: "os_shell_run", arguments: { cmd: "touch", args: [target] } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(MCP_SERVE_REFUSAL);
    expect(existsSync(target)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("still runs a command the policy does not cover", async () => {
    const c = await connect(systemPolicy([{ action: "shell", resource: "rm *", effect: "deny" }]), 5);
    const target = join(tmp, "allowed");
    const result = await c.callTool({ name: "os_shell_run", arguments: { cmd: "touch", args: [target] } });
    expect(result.isError).toBeFalsy();
    expect(existsSync(target)).toBe(true);
  });
});
