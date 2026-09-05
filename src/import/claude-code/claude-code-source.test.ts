import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeCodeSource } from "./claude-code-source.js";

function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

describe("ClaudeCodeSource", () => {
  let home: string;
  let stateDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "claude-src-"));
    stateDir = join(home, ".claude");
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("lists only skill dirs holding a SKILL.md", () => {
    mkdirSync(join(stateDir, "skills", "beta"), { recursive: true });
    writeFileSync(join(stateDir, "skills", "beta", "SKILL.md"), "---\nname: beta\n---\n");
    mkdirSync(join(stateDir, "skills", "alpha"), { recursive: true });
    writeFileSync(join(stateDir, "skills", "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
    mkdirSync(join(stateDir, "skills", "not-a-skill"), { recursive: true });

    const source = new ClaudeCodeSource(stateDir);
    expect(source.listSkills().map((s) => s.name)).toEqual(["alpha", "beta"]);
  });

  it("collects memory notes and CLAUDE.md, skipping the MEMORY.md index", () => {
    writeFileSync(join(stateDir, "CLAUDE.md"), "always be typing\n");
    const memoryDir = join(stateDir, "projects", "-home-me-app", "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), "# index\n");
    writeFileSync(join(memoryDir, "fact.md"), "the deploy takes ten minutes\n");
    writeFileSync(join(memoryDir, "empty.md"), "   \n");

    const source = new ClaudeCodeSource(stateDir);
    const files = source.listMemoryFiles();
    expect(files.map((f) => f.relPath)).toEqual([
      "CLAUDE.md",
      join("projects", "-home-me-app", "memory", "fact.md"),
    ]);
    expect(files[1]!.content).toBe("the deploy takes ten minutes");
  });

  it("reads mcpServers from the sibling ~/.claude.json", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          linear: { type: "http", url: "https://mcp.linear.app/mcp" },
          gmail: { command: "npx", args: ["gmail-mcp"], env: { X: "1" } },
        },
        otherKey: true,
      }),
    );
    const source = new ClaudeCodeSource(stateDir);
    const servers = source.readMcpServers();
    expect(servers.map((s) => s.name)).toEqual(["linear", "gmail"]);
  });

  it("reads only allowlisted env keys from settings.json", () => {
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({
        env: { ANTHROPIC_API_KEY: "sk-ant-x", PATH: "/evil", EMPTY: "" },
      }),
    );
    const source = new ClaudeCodeSource(stateDir);
    const keys = source.readEnvKeys(["ANTHROPIC_API_KEY", "EMPTY"]);
    expect([...keys.entries()]).toEqual([["ANTHROPIC_API_KEY", "sk-ant-x"]]);
  });

  it("lists transcripts newest-first and projects their rows", () => {
    const projectDir = join(stateDir, "projects", "-work-repo");
    mkdirSync(projectDir, { recursive: true });
    const older = join(projectDir, "aaa.jsonl");
    const newer = join(projectDir, "bbb.jsonl");
    writeFileSync(
      older,
      line({
        type: "user",
        cwd: "/work/repo",
        timestamp: "2026-08-01T10:00:00Z",
        message: { role: "user", content: "hello there" },
      }),
    );
    writeFileSync(
      newer,
      [
        line({ type: "queue-operation", operation: "x" }),
        line({ type: "ai-title", aiTitle: "Fixing the build" }),
        line({
          type: "user",
          cwd: "/work/repo",
          timestamp: "2026-08-02T10:00:00Z",
          message: { role: "user", content: "fix the build" },
        }),
        line({
          type: "assistant",
          timestamp: "2026-08-02T10:00:05Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "look at CI first" },
              { type: "text", text: "on it" },
              { type: "tool_use", id: "t1", name: "Bash", input: { command: "make" } },
            ],
          },
        }),
        line({
          type: "user",
          timestamp: "2026-08-02T10:00:09Z",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "built", is_error: false },
            ],
          },
        }),
        line({
          type: "user",
          isSidechain: true,
          timestamp: "2026-08-02T10:00:10Z",
          message: { role: "user", content: "subagent chatter" },
        }),
        "not json at all\n",
      ].join(""),
    );
    utimesSync(older, new Date("2026-08-01T10:00:00Z"), new Date("2026-08-01T10:00:00Z"));
    utimesSync(newer, new Date("2026-08-02T10:00:00Z"), new Date("2026-08-02T10:00:00Z"));

    const source = new ClaudeCodeSource(stateDir);
    const metas = source.listSessions();
    expect(metas.map((m) => m.id)).toEqual(["bbb", "aaa"]);

    const session = source.readSession(metas[0]!);
    expect(session.id).toBe("bbb");
    expect(session.cwd).toBe("/work/repo");
    expect(session.title).toBe("Fixing the build");
    expect(session.messages).toHaveLength(3);
    expect(session.messages[0]).toMatchObject({
      role: "user",
      blocks: [{ type: "text", text: "fix the build" }],
    });
    expect(session.messages[1]!.blocks).toEqual([
      { type: "thinking", thinking: "look at CI first" },
      { type: "text", text: "on it" },
      { type: "toolUse", id: "t1", name: "Bash", args: { command: "make" } },
    ]);
    expect(session.messages[2]!.blocks).toEqual([
      { type: "toolResult", toolUseId: "t1", text: "built", isError: false },
    ]);
  });

  it("prefers a custom title over the ai title", () => {
    const projectDir = join(stateDir, "projects", "p");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "s.jsonl"),
      [
        line({ type: "ai-title", aiTitle: "generated" }),
        line({ type: "custom-title", customTitle: "mine" }),
        line({
          type: "user",
          timestamp: "2026-08-02T10:00:00Z",
          message: { role: "user", content: "hi" },
        }),
      ].join(""),
    );
    const source = new ClaudeCodeSource(stateDir);
    expect(source.readSession(source.listSessions()[0]!).title).toBe("mine");
  });
});
