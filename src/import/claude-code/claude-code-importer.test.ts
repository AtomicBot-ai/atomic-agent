import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
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
import { groupImportReport } from "../grouping.js";
import { ClaudeCodeSource, decodeProjectSlug } from "./claude-code-source.js";
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
    sessionStore = new SessionStore({
      dbFile: join(stateDir, "sessions.sqlite"),
    });
    memoryContents = [];
  });

  afterEach(() => {
    sessionStore.close();
    rmSync(home, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    rmSync(stateDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  function seedSkill(): void {
    mkdirSync(join(sourceDir, "skills", "triage"), { recursive: true });
    writeFileSync(join(sourceDir, "skills", "triage", "SKILL.md"), SKILL_MD);
    writeFileSync(
      join(sourceDir, "skills", "triage", "notes.txt"),
      "extra file",
    );
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
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
          },
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
        mcpServers: {
          linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        },
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
    expect(existsSync(join(stateDir, "skills", "triage", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(stateDir, "skills", "triage", "notes.txt"))).toBe(
      true,
    );
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
      options: resolveClaudeCodeOptions({
        exclude: ["memory", "mcp", "sessions"],
      }),
      execute: true,
      overwrite: false,
    });
    expect(third.items[0]).toMatchObject({
      kind: "skills",
      status: "conflict",
    });

    const forced = await buildImporter().run({
      options: resolveClaudeCodeOptions({
        exclude: ["memory", "mcp", "sessions"],
      }),
      execute: true,
      overwrite: true,
    });
    expect(forced.items[0]).toMatchObject({
      kind: "skills",
      status: "migrated",
      reason: "overwritten",
    });
  });

  it("picks up turns a session gained since the last import", async () => {
    seedSession();
    const options = resolveClaudeCodeOptions({
      exclude: ["skills", "memory", "mcp"],
    });
    await buildImporter().run({ options, execute: true, overwrite: false });
    expect(sessionStore.load("claude-code:s1")?.turns).toHaveLength(2);

    // The operator kept talking to Claude Code: the transcript grew.
    appendFileSync(
      join(sourceDir, "projects", "-work", "s1.jsonl"),
      line({
        type: "user",
        timestamp: "2026-08-02T10:05:00Z",
        message: { role: "user", content: "and one more thing" },
      }),
    );
    const second = await buildImporter().run({
      options,
      execute: true,
      overwrite: false,
    });
    expect(second.items[0]).toMatchObject({
      kind: "sessions",
      status: "migrated",
      reason: "updated (+1 turns)",
    });
    expect(sessionStore.load("claude-code:s1")?.turns).toHaveLength(3);
  });

  it("skips an mcp server whose name is already configured", async () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        },
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
      options: resolveClaudeCodeOptions({
        exclude: ["skills", "memory", "mcp"],
      }),
      execute: false,
      overwrite: false,
    });
    expect(report.items.filter((i) => i.kind === "sessions")).toHaveLength(3);

    const limited = await buildImporter().run({
      options: resolveClaudeCodeOptions({
        exclude: ["skills", "memory", "mcp"],
      }),
      execute: false,
      overwrite: false,
      limit: 2,
    });
    expect(limited.items.filter((i) => i.kind === "sessions")).toHaveLength(2);
  });

  it("lists a transcript without messages as skipped, so counts add up", async () => {
    const projectDir = join(sourceDir, "projects", "p");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "warmup.jsonl"),
      line({ type: "ai-title", aiTitle: "nothing said yet" }),
    );
    const report = await buildImporter().run({
      options: resolveClaudeCodeOptions({
        exclude: ["skills", "memory", "mcp"],
      }),
      execute: true,
      overwrite: false,
    });
    expect(report.items).toEqual([
      {
        kind: "sessions",
        source: "warmup",
        status: "skipped",
        reason: "no messages",
      },
    ]);
    expect(sessionStore.load("claude-code:warmup")).toBeNull();
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

  // W2 (owner: "only flat chats were imported"): the project folders survive.
  describe("projects and folders", () => {
    function seedProjectSession(cwd: string, id: string, at: string, withCwd = true): void {
      const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
      const projectDir = join(sourceDir, "projects", slug);
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, `${id}.jsonl`),
        [
          line({ type: "ai-title", aiTitle: `title ${id}` }),
          line({
            type: "user",
            ...(withCwd ? { cwd } : {}),
            timestamp: at,
            message: { role: "user", content: `question ${id}` },
          }),
          line({
            type: "assistant",
            ...(withCwd ? { cwd } : {}),
            timestamp: at,
            message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
          }),
        ].join(""),
      );
    }

    async function importOnce(execute: boolean) {
      const report = await buildImporter().run({
        options: resolveClaudeCodeOptions({ exclude: ["skills", "memory", "mcp"] }),
        execute,
        overwrite: false,
      });
      return groupImportReport(report, { stateDir, execute });
    }

    it("puts each project's chats into a Project for its folder, or a chat folder when the folder is gone", async () => {
      const shop = join(home, "code", "shop");
      const blog = join(home, "code", "blog");
      mkdirSync(shop, { recursive: true });
      mkdirSync(blog, { recursive: true });
      seedProjectSession(shop, "s-shop-1", "2026-08-02T10:00:00Z");
      seedProjectSession(shop, "s-shop-2", "2026-08-03T10:00:00Z");
      seedProjectSession(blog, "s-blog-1", "2026-08-04T10:00:00Z");
      seedProjectSession(join(home, "gone", "legacy"), "s-gone-1", "2026-08-05T10:00:00Z");

      const report = await importOnce(true);
      const groups = report.items.filter((i) => (i.kind as string) === "projects" || (i.kind as string) === "folders");
      expect(groups.map((g) => [g.kind, g.source, g.reason])).toEqual(
        expect.arrayContaining([
          ["projects", "shop", "new project; 2 chats; 2 added"],
          ["projects", "blog", "new project; 1 chat; 1 added"],
          ["folders", "legacy", "new folder; 1 chat; 1 added"],
        ]),
      );
      const projects = JSON.parse(readFileSync(join(stateDir, "projects.json"), "utf8"));
      const shopProject = projects.projects.find((p: { folder: string }) => p.folder === shop);
      expect(shopProject.name).toBe("shop");
      expect(projects.chats["claude-code:s-shop-1"]).toBe(shopProject.id);
      expect(projects.chats["claude-code:s-shop-2"]).toBe(shopProject.id);
      const folders = JSON.parse(readFileSync(join(stateDir, "chat-folders.json"), "utf8"));
      const legacy = folders.folders.find((f: { name: string }) => f.name === "legacy");
      expect(folders.chats["claude-code:s-gone-1"]).toBe(legacy.id);
      // Each chat keeps its own folder, titles and times: continuing it runs there.
      const state = sessionStore.load("claude-code:s-shop-1")!;
      expect(state.workingDir).toBe(shop);
      expect(state.metadata.title).toBe("title s-shop-1");
      expect(state.createdAt).toBe(Date.parse("2026-08-02T10:00:00Z"));
    });

    it("re-imports without a second project, folder or chat", async () => {
      const shop = join(home, "code", "shop");
      mkdirSync(shop, { recursive: true });
      seedProjectSession(shop, "s-shop-1", "2026-08-02T10:00:00Z");
      seedProjectSession(join(home, "gone", "legacy"), "s-gone-1", "2026-08-05T10:00:00Z");
      await importOnce(true);
      const projectsBefore = readFileSync(join(stateDir, "projects.json"), "utf8");
      const foldersBefore = readFileSync(join(stateDir, "chat-folders.json"), "utf8");

      const again = await importOnce(true);
      expect(again.summary.migrated).toBe(0);
      expect(again.items.filter((i) => i.kind === "sessions").every((i) => i.status === "skipped")).toBe(true);
      expect(readFileSync(join(stateDir, "projects.json"), "utf8")).toBe(projectsBefore);
      expect(readFileSync(join(stateDir, "chat-folders.json"), "utf8")).toBe(foldersBefore);
    });

    it("files chats imported flat before into their projects on the next run", async () => {
      const shop = join(home, "code", "shop");
      mkdirSync(shop, { recursive: true });
      seedProjectSession(shop, "s-shop-1", "2026-08-02T10:00:00Z");
      // The earlier import: the chats, and no grouping.
      await buildImporter().run({
        options: resolveClaudeCodeOptions({ exclude: ["skills", "memory", "mcp"] }),
        execute: true,
        overwrite: false,
      });
      const report = await importOnce(true);
      expect(report.items.find((i) => i.kind === "sessions")).toMatchObject({ status: "skipped" });
      expect(report.items.find((i) => (i.kind as string) === "projects")).toMatchObject({ status: "migrated", source: "shop" });
    });

    it("finds the folder from the project dir's name when no row carries a cwd", async () => {
      const shop = join(home, "my.code", "shop-app");
      mkdirSync(shop, { recursive: true });
      seedProjectSession(shop, "s-1", "2026-08-02T10:00:00Z", false);
      const report = await importOnce(false);
      expect(report.items.find((i) => (i.kind as string) === "projects")).toMatchObject({ source: "shop-app", destination: shop });
    });
  });

  it("decodes Claude Code's project dir names against the disk", () => {
    const dirs = new Set(["/Users", "/Users/me", "/Users/me/my-app", "/Users/me/.config", "/Users/me/.config/x"]);
    const isDir = (p: string) => dirs.has(p);
    expect(decodeProjectSlug("-Users-me-my-app", isDir)).toBe("/Users/me/my-app");
    expect(decodeProjectSlug("-Users-me--config-x", isDir)).toBe("/Users/me/.config/x");
    expect(decodeProjectSlug("-Users-me-gone", isDir)).toBeNull();
    expect(decodeProjectSlug("C--work", isDir)).toBeNull();
  });
});
