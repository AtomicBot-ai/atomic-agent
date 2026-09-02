import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureUserConfigFileSync } from "../../config/index.js";
import { SessionStore } from "../../session/index.js";
import { ClaudeCodeImporter } from "./claude-code-importer.js";
import { ClaudeCodeSource } from "./claude-code-source.js";
import { resolveClaudeCodeOptions } from "./import-options.js";

function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

const SKILL_MD = [
  "---",
  "name: triage",
  "description: Sort the inbox",
  "---",
  "",
  "# triage",
  "",
].join("\n");

describe("ClaudeCodeImporter", () => {
  let home: string;
  let sourceDir: string;
  let stateDir: string;
  let sessionStore: SessionStore;
  let memoryContents: string[];

  function memoryStore() {
    return {
      list: () => memoryContents.map((content) => ({ content })),
      store: (input: { content: string }) => {
        memoryContents.push(input.content);
      },
    };
  }

  function buildImporter(): ClaudeCodeImporter {
    return new ClaudeCodeImporter({
      source: new ClaudeCodeSource(sourceDir),
      sessionStore,
      memoryStore: memoryStore(),
      stateDir,
      userConfigFile: join(stateDir, "config.json"),
      globalSkillsDir: join(stateDir, "skills"),
      workingDirFallback: "/fallback",
    });
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cc-imp-src-"));
    sourceDir = join(home, ".claude");
    mkdirSync(sourceDir, { recursive: true });
    stateDir = mkdtempSync(join(tmpdir(), "cc-imp-dst-"));
    sessionStore = new SessionStore({ dbFile: join(stateDir, "sessions.sqlite") });
    memoryContents = [];
  });

  afterEach(() => {
    sessionStore.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function seedSkill(): void {
    mkdirSync(join(sourceDir, "skills", "triage"), { recursive: true });
    writeFileSync(join(sourceDir, "skills", "triage", "SKILL.md"), SKILL_MD);
    writeFileSync(join(sourceDir, "skills", "triage", "notes.txt"), "extra file");
  }

  function seedSession(): void {
    const projectDir = join(sourceDir, "projects", "-work");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "s1.jsonl"),
      [
        line({
          type: "user",
          cwd: "/work",
          timestamp: "2026-08-02T10:00:00Z",
          message: { role: "user", content: "hi" },
        }),
        line({
          type: "assistant",
          timestamp: "2026-08-02T10:00:01Z",
          message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
        }),
      ].join(""),
    );
  }

  it("imports skills, memory, mcp, sessions and (opt-in) the key", async () => {
    seedSkill();
    seedSession();
    writeFileSync(join(sourceDir, "CLAUDE.md"), "be brief\n");
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
      }),
    );
    writeFileSync(
      join(sourceDir, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-1" } }),
    );

    const report = await buildImporter().run({
      options: resolveClaudeCodeOptions({ migrateSecrets: true }),
      execute: true,
      overwrite: false,
    });

    expect(report.executed).toBe(true);
    expect(report.summary.error).toBe(0);
    expect(report.summary.conflict).toBe(0);
    expect(report.summary.migrated).toBe(5);

    // Skill dir copied whole, under the manifest name.
    expect(existsSync(join(stateDir, "skills", "triage", "SKILL.md"))).toBe(true);
    expect(existsSync(join(stateDir, "skills", "triage", "notes.txt"))).toBe(true);
    // Memory note stored.
    expect(memoryContents).toEqual(["be brief"]);
    // MCP server appended to the user config.
    const config = ensureUserConfigFileSync(join(stateDir, "config.json"));
    expect(config.mcp.servers.map((s) => s.name)).toEqual(["linear"]);
    // Session saved under the prefixed id.
    expect(sessionStore.load("claude-code:s1")).not.toBeNull();
    // Key written to .env.
    expect(readFileSync(join(stateDir, ".env"), "utf8")).toContain(
      "ANTHROPIC_API_KEY=",
    );
  });

  it("previews without writing anything", async () => {
    seedSkill();
    seedSession();
    const report = await buildImporter().run({
      options: resolveClaudeCodeOptions(),
      execute: false,
      overwrite: false,
    });
    expect(report.executed).toBe(false);
    expect(report.summary.migrated).toBe(2); // skill + session
    expect(existsSync(join(stateDir, "skills", "triage"))).toBe(false);
    expect(sessionStore.load("claude-code:s1")).toBeNull();
  });

  it("re-runs idempotently: matches skip, differing skills conflict", async () => {
    seedSkill();
    seedSession();
    const importer = buildImporter();
    const options = resolveClaudeCodeOptions();
    await importer.run({ options, execute: true, overwrite: false });

    const second = await buildImporter().run({
      options,
      execute: true,
      overwrite: false,
    });
    expect(second.summary.migrated).toBe(0);
    expect(second.items.every((i) => i.status === "skipped")).toBe(true);

    // A drifted source manifest is a conflict until --overwrite.
    writeFileSync(
      join(sourceDir, "skills", "triage", "SKILL.md"),
      SKILL_MD.replace("Sort the inbox", "Sort the inbox twice"),
    );
    const third = await buildImporter().run({
      options: resolveClaudeCodeOptions({ exclude: ["memory", "mcp", "sessions"] }),
      execute: true,
      overwrite: false,
    });
    expect(third.items[0]).toMatchObject({ kind: "skills", status: "conflict" });

    const forced = await buildImporter().run({
      options: resolveClaudeCodeOptions({ exclude: ["memory", "mcp", "sessions"] }),
      execute: true,
      overwrite: true,
    });
    expect(forced.items[0]).toMatchObject({
      kind: "skills",
      status: "migrated",
      reason: "overwritten",
    });
  });

  it("skips an mcp server whose name is already configured", async () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
      }),
    );
    const importer = buildImporter();
    const options = resolveClaudeCodeOptions({
      exclude: ["skills", "memory", "sessions"],
    });
    await importer.run({ options, execute: true, overwrite: false });
    const second = await buildImporter().run({
      options,
      execute: true,
      overwrite: false,
    });
    expect(second.items[0]).toMatchObject({
      kind: "mcp",
      status: "skipped",
      reason: "server with this name already configured",
    });
  });

  it("caps sessions at the limit, newest first", async () => {
    const projectDir = join(sourceDir, "projects", "p");
    mkdirSync(projectDir, { recursive: true });
    for (const id of ["a", "b", "c"]) {
      writeFileSync(
        join(projectDir, `${id}.jsonl`),
        line({
          type: "user",
          timestamp: "2026-08-02T10:00:00Z",
          message: { role: "user", content: `msg ${id}` },
        }),
      );
    }
    const report = await buildImporter().run({
      options: resolveClaudeCodeOptions({ exclude: ["skills", "memory", "mcp"] }),
      execute: false,
      overwrite: false,
    });
    expect(report.items.filter((i) => i.kind === "sessions")).toHaveLength(3);

    const limited = await buildImporter().run({
      options: resolveClaudeCodeOptions({ exclude: ["skills", "memory", "mcp"] }),
      execute: false,
      overwrite: false,
      limit: 2,
    });
    expect(limited.items.filter((i) => i.kind === "sessions")).toHaveLength(2);
  });

  it("reports empty domains as skipped with a reason", async () => {
    const report = await buildImporter().run({
      options: resolveClaudeCodeOptions({ migrateSecrets: true }),
      execute: true,
      overwrite: false,
    });
    expect(report.summary.migrated).toBe(0);
    expect(report.items.map((i) => [i.kind, i.status])).toEqual([
      ["skills", "skipped"],
      ["memory", "skipped"],
      ["mcp", "skipped"],
      ["sessions", "skipped"],
      ["secrets", "skipped"],
    ]);
  });
});
