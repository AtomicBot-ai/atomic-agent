import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../approval/approval-gate.js";
import { MemoryStore } from "../memory/memory-store.js";
import { ProfileStore } from "../memory/profile-store.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { SkillRecord } from "../skills/skill-loader.js";
import { McpServerUsageError } from "./mcp-server-args.js";
import {
  buildMcpServeTools,
  toWireName,
  type McpServeToolDeps,
} from "./mcp-server-tools.js";

function fakeSkillRegistry(skills: Array<{ name: string; description: string; body: string }>): SkillRegistry {
  const records = skills.map(
    (s): SkillRecord => ({
      manifest: {
        name: s.name,
        description: s.description,
        version: "1.0.0",
        requiresTools: [],
        requiresScripts: [],
        dangerous: false,
      },
      rootDir: `/skills/${s.name}`,
      manifestPath: `/skills/${s.name}/SKILL.md`,
      source: "global",
    }),
  );
  return {
    list: () => records,
    get: (name: string) => {
      const hit = records.find((r) => r.manifest.name === name);
      if (!hit) throw new Error(`skill not found: ${name}`);
      return hit;
    },
    readBody: async (name: string) => skills.find((s) => s.name === name)!.body,
  } as unknown as SkillRegistry;
}

describe("buildMcpServeTools (ATO-549)", () => {
  let tmp: string;
  let notes: MemoryStore;
  let profile: ProfileStore;
  let deps: McpServeToolDeps;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-mcp-serve-tools-"));
    const dbFile = join(tmp, "memory.sqlite");
    notes = new MemoryStore({ dbFile, maxEntries: 100 });
    profile = new ProfileStore({ dbFile });
    deps = {
      notesStore: notes,
      profileStore: profile,
      notesRecallDefaultK: 5,
      notesMaxContentChars: 2000,
      skillRegistry: fakeSkillRegistry([{ name: "pdf", description: "Work with PDFs", body: "# pdf" }]),
      approvals: new ApprovalGate({ emit: () => undefined, level: 1 }),
    };
  });

  afterEach(() => {
    notes.close();
    profile.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const none = { allowWrite: false, allowExec: false, tools: [] as string[] };

  it("exposes only read-only tools by default", () => {
    const set = buildMcpServeTools(none, deps);
    expect(set.tools.map((t) => t.wireName)).toEqual([
      "memory_notes_recall",
      "memory_profile_list",
      "skills_list",
      "skill_view",
    ]);
    expect(set.tools.every((t) => t.definition.readonly)).toBe(true);
  });

  it("adds the memory writes only with --allow-write, the shell only with --allow-exec", () => {
    const write = buildMcpServeTools({ ...none, allowWrite: true }, deps).tools.map((t) => t.wireName);
    expect(write).toContain("memory_notes_store");
    expect(write).toContain("memory_profile_set");
    expect(write).not.toContain("os_shell_run");

    const exec = buildMcpServeTools({ ...none, allowExec: true }, deps).tools.map((t) => t.wireName);
    expect(exec).toContain("os_shell_run");
    expect(exec).not.toContain("memory_notes_store");
  });

  it("leaves out a memory family whose store is off", () => {
    const rest: McpServeToolDeps = { ...deps };
    delete rest.notesStore;
    delete rest.profileStore;
    const names = buildMcpServeTools({ ...none, allowWrite: true }, rest).tools.map((t) => t.wireName);
    expect(names).toEqual(["skills_list", "skill_view"]);
  });

  it("narrows to --tool names, wire or dotted, and refuses one that is not available", () => {
    const set = buildMcpServeTools({ ...none, tools: ["skills_list", "memory.notes.recall"] }, deps);
    expect(set.tools.map((t) => t.wireName)).toEqual(["memory_notes_recall", "skills_list"]);
    expect(() => buildMcpServeTools({ ...none, tools: ["os_shell_run"] }, deps)).toThrow(McpServerUsageError);
  });

  it("uses names without dots and the agent's own JSON Schemas", () => {
    const set = buildMcpServeTools({ ...none, allowWrite: true, allowExec: true }, deps);
    for (const t of set.tools) {
      expect(t.wireName).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(t.inputSchema.type).toBe("object");
      expect(set.byWireName.get(t.wireName)).toBe(t.definition.name);
    }
    const recall = set.tools.find((t) => t.wireName === "memory_notes_recall")!;
    expect(Object.keys(recall.inputSchema.properties as object)).toContain("query");
    expect(toWireName("os.shell.run")).toBe("os_shell_run");
  });

  it("skills_list lists name, description and source", async () => {
    const set = buildMcpServeTools(none, deps);
    const result = await set.registry.invoke("skills.list", {}, {
      workingDir: tmp,
      sessionId: "mcp-server",
      stepIndex: 0,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("- pdf: Work with PDFs (global)");
  });
});
