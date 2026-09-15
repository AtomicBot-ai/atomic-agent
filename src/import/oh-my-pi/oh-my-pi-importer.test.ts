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

import { SessionStore } from "../../session/index.js";
import { resolveOhMyPiOptions } from "./import-options.js";
import { OhMyPiImporter } from "./oh-my-pi-importer.js";
import { OhMyPiSource } from "./oh-my-pi-source.js";

function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

const T0 = Date.parse("2026-08-02T10:00:00Z");

const SKILL_MD = "---\nname: triage\ndescription: Sort the inbox\n---\nBody\n";

describe("OhMyPiImporter", () => {
  let sourceDir: string;
  let stateDir: string;
  let sessionStore: SessionStore;
  let userConfigFile: string;

  function buildImporter(): OhMyPiImporter {
    return new OhMyPiImporter({
      source: new OhMyPiSource(sourceDir),
      sessionStore,
      userConfigFile,
      globalSkillsDir: join(stateDir, "skills"),
      workingDirFallback: "/fallback",
    });
  }

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "omp-imp-src-"));
    stateDir = mkdtempSync(join(tmpdir(), "omp-imp-dst-"));
    userConfigFile = join(stateDir, "config.json");
    sessionStore = new SessionStore({
      dbFile: join(stateDir, "sessions.sqlite"),
    });
  });

  afterEach(() => {
    sessionStore.close();
    rmSync(sourceDir, {
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

  function seedAll(): void {
    const skillDir = join(sourceDir, "skills", "triage");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), SKILL_MD);
    writeFileSync(
      join(sourceDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          files: { command: "npx", args: ["-y", "server-filesystem"] },
          paused: { command: "npx", enabled: false },
        },
      }),
    );
    const sessionDir = join(sourceDir, "sessions", "--work--");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "2026-08-02T10-00-00-000Z_sess-1.jsonl"),
      [
        line({
          type: "session",
          version: 3,
          id: "sess-1",
          timestamp: "2026-08-02T10:00:00.000Z",
          cwd: "/work",
        }),
        line({
          type: "message",
          id: "e1",
          parentId: null,
          timestamp: "2026-08-02T10:00:01.000Z",
          message: { role: "user", content: "hello", timestamp: T0 },
        }),
      ].join(""),
    );
  }

  function configuredServers(): Array<{ name: string; enabled: boolean }> {
    const parsed = JSON.parse(readFileSync(userConfigFile, "utf8")) as {
      mcp: { servers: Array<{ name: string; enabled: boolean }> };
    };
    return parsed.mcp.servers.map((s) => ({
      name: s.name,
      enabled: s.enabled,
    }));
  }

  it("imports skills, mcp and sessions", async () => {
    seedAll();
    const report = await buildImporter().run({
      options: resolveOhMyPiOptions(),
      execute: true,
      overwrite: false,
    });

    expect(report.summary).toEqual({
      migrated: 4,
      skipped: 0,
      conflict: 0,
      error: 0,
    });
    expect(existsSync(join(stateDir, "skills", "triage", "SKILL.md"))).toBe(
      true,
    );
    expect(configuredServers()).toEqual([
      { name: "files", enabled: true },
      { name: "paused", enabled: false },
    ]);
    const paused = report.items.find((item) => item.source === "paused");
    expect(paused).toMatchObject({
      kind: "mcp",
      status: "migrated",
      reason: "disabled in mcp.json",
    });

    const session = sessionStore.load("oh-my-pi:sess-1");
    expect(session).not.toBeNull();
    expect(session!.metadata).toEqual({
      importedFrom: "oh-my-pi",
      ohMyPiSessionId: "sess-1",
    });
  });

  it("previews without writing and skips configured names on re-run", async () => {
    seedAll();
    const importer = buildImporter();

    const preview = await importer.run({
      options: resolveOhMyPiOptions(),
      execute: false,
      overwrite: false,
    });
    expect(preview.summary.migrated).toBe(4);
    expect(configuredServers()).toEqual([]);
    expect(sessionStore.load("oh-my-pi:sess-1")).toBeNull();

    await importer.run({
      options: resolveOhMyPiOptions(),
      execute: true,
      overwrite: false,
    });
    const rerun = await importer.run({
      options: resolveOhMyPiOptions(),
      execute: true,
      overwrite: false,
    });
    expect(rerun.summary).toEqual({
      migrated: 0,
      skipped: 4,
      conflict: 0,
      error: 0,
    });
    const mcpReasons = rerun.items
      .filter((item) => item.kind === "mcp")
      .map((item) => item.reason);
    expect(mcpReasons).toEqual([
      "server with this name already configured",
      "server with this name already configured",
    ]);
    // The config still holds exactly one copy of each.
    expect(configuredServers()).toHaveLength(2);
  });

  it("surfaces a corrupt mcp.json as an error item", async () => {
    writeFileSync(join(sourceDir, "mcp.json"), "{ not json");
    const report = await buildImporter().run({
      options: resolveOhMyPiOptions({ exclude: ["skills", "sessions"] }),
      execute: true,
      overwrite: false,
    });
    expect(report.items).toMatchObject([{ kind: "mcp", status: "error" }]);
    expect(report.items[0]!.reason).toMatch(/failed to parse/);
  });

  it("reports empty domains as skipped with a reason", async () => {
    const report = await buildImporter().run({
      options: resolveOhMyPiOptions(),
      execute: true,
      overwrite: false,
    });
    expect(report.items).toMatchObject([
      { kind: "skills", status: "skipped" },
      { kind: "mcp", status: "skipped" },
      { kind: "sessions", status: "skipped" },
    ]);
    expect(report.items[1]!.reason).toMatch(/no mcpServers found in /);
  });
});
