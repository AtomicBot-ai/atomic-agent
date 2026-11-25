import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApprovalGate, type ApprovalRequest } from "../approval/approval-gate.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { SkillRecord } from "../skills/skill-loader.js";
import { buildMcpServeTools } from "./mcp-server-tools.js";
import {
  createMcpServeServer,
  MCP_SERVE_REFUSAL,
  MCP_SERVE_SESSION_ID,
} from "./mcp-server-bridge.js";

function oneSkill(): SkillRegistry {
  const record: SkillRecord = {
    manifest: {
      name: "pdf",
      description: "Work with PDFs",
      version: "1.2.0",
      requiresTools: [],
      requiresScripts: [],
      dangerous: false,
    },
    rootDir: "/skills/pdf",
    manifestPath: "/skills/pdf/SKILL.md",
    source: "global",
  };
  return {
    list: () => [record],
    get: () => record,
    readBody: async () => "Use pdftotext first.",
  } as unknown as SkillRegistry;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");
}

describe("atomic-agent mcp-server over MCP (ATO-549)", () => {
  let tmp: string;
  let notes: MemoryStore;
  let asked: ApprovalRequest[];
  let approvals: ApprovalGate;
  let client: Client;

  async function connect(flags: { allowWrite?: boolean; allowExec?: boolean } = {}): Promise<void> {
    const toolSet = buildMcpServeTools(
      { allowWrite: flags.allowWrite ?? false, allowExec: flags.allowExec ?? false, tools: [] },
      {
        notesStore: notes,
        notesRecallDefaultK: 5,
        notesMaxContentChars: 2000,
        skillRegistry: oneSkill(),
        approvals,
      },
    );
    const server = createMcpServeServer({ toolSet, workingDir: tmp, version: "0.0.0-test" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientSide);
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-mcp-serve-bridge-"));
    notes = new MemoryStore({ dbFile: join(tmp, "memory.sqlite"), maxEntries: 100 });
    asked = [];
    approvals = new ApprovalGate({ emit: (r) => asked.push(r), level: 1 });
    approvals.setSessionPolicy(MCP_SERVE_SESSION_ID, { onPrompt: "refuse", reason: MCP_SERVE_REFUSAL });
  });

  afterEach(async () => {
    await client?.close();
    notes.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("lists the read-only tools with schemas and a read-only hint", async () => {
    await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["memory_notes_recall", "skills_list", "skill_view"]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("searches memory notes and returns the whole note", async () => {
    const long = `pnpm install needs --frozen-lockfile in CI. ${"detail ".repeat(60)}end-marker`;
    notes.store({ content: long });
    await connect();
    const result = await client.callTool({ name: "memory_notes_recall", arguments: { query: "pnpm lockfile" } });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("end-marker");
  });

  it("lists and opens skills", async () => {
    await connect();
    expect(text(await client.callTool({ name: "skills_list", arguments: {} }))).toContain("pdf: Work with PDFs");
    expect(text(await client.callTool({ name: "skill_view", arguments: { name: "pdf" } }))).toContain(
      "Use pdftotext first.",
    );
  });

  it("answers an unknown or unexposed tool with an error result", async () => {
    await connect();
    const result = await client.callTool({ name: "memory_notes_store", arguments: { content: "x" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("unknown tool");
  });

  it("stores a note only when --allow-write exposed the tool", async () => {
    await connect({ allowWrite: true });
    const result = await client.callTool({
      name: "memory_notes_store",
      arguments: { content: "the staging server is behind the VPN" },
    });
    expect(result.isError).toBeFalsy();
    expect(notes.recall("staging VPN").length).toBe(1);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a shell command that would need an approval, without prompting anyone",
    async () => {
      await connect({ allowExec: true });
      const target = join(tmp, "created-by-mcp");
      const result = await client.callTool({
        name: "os_shell_run",
        arguments: { cmd: "touch", args: [target] },
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("an MCP client cannot show");
      expect(existsSync(target)).toBe(false);
      expect(asked).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "runs a shell command the approval level already allows",
    async () => {
      approvals.setLevel(5);
      await connect({ allowExec: true });
      const target = join(tmp, "allowed-by-level");
      const result = await client.callTool({
        name: "os_shell_run",
        arguments: { cmd: "touch", args: [target] },
      });
      expect(result.isError).toBeFalsy();
      expect(existsSync(target)).toBe(true);
    },
  );
});
