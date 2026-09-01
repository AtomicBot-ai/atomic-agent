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
import { CodexImporter } from "./codex-importer.js";
import { CodexSource } from "./codex-source.js";
import { resolveCodexOptions } from "./import-options.js";

function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

describe("CodexImporter", () => {
  let sourceDir: string;
  let stateDir: string;
  let sessionStore: SessionStore;
  let memoryContents: string[];

  function buildImporter(): CodexImporter {
    return new CodexImporter({
      source: new CodexSource(sourceDir),
      sessionStore,
      memoryStore: {
        list: () => memoryContents.map((content) => ({ content })),
        store: (input: { content: string }) => {
          memoryContents.push(input.content);
        },
      },
      stateDir,
      globalSkillsDir: join(stateDir, "skills"),
      workingDirFallback: "/fallback",
    });
  }

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "codex-imp-src-"));
    stateDir = mkdtempSync(join(tmpdir(), "codex-imp-dst-"));
    sessionStore = new SessionStore({ dbFile: join(stateDir, "sessions.sqlite") });
    memoryContents = [];
  });

  afterEach(() => {
    sessionStore.close();
    rmSync(sourceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function seedAll(): void {
    mkdirSync(join(sourceDir, "skills", "review"), { recursive: true });
    writeFileSync(
      join(sourceDir, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review code\n---\n",
    );
    writeFileSync(join(sourceDir, "AGENTS.md"), "prefer bun\n");
    writeFileSync(
      join(sourceDir, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-o-1" }),
    );
    mkdirSync(join(sourceDir, "sessions"), { recursive: true });
    writeFileSync(
      join(sourceDir, "sessions", "rollout-x.jsonl"),
      [
        line({
          timestamp: "2026-08-02T10:00:00Z",
          type: "session_meta",
          payload: { id: "sess-1", cwd: "/work" },
        }),
        line({
          timestamp: "2026-08-02T10:00:01Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        }),
      ].join(""),
    );
  }

  it("imports skills, instructions, sessions and (opt-in) the key", async () => {
    seedAll();
    const report = await buildImporter().run({
      options: resolveCodexOptions({ migrateSecrets: true }),
      execute: true,
      overwrite: false,
    });

    expect(report.summary.error).toBe(0);
    expect(report.summary.migrated).toBe(4);
    expect(existsSync(join(stateDir, "skills", "review", "SKILL.md"))).toBe(true);
    expect(memoryContents).toEqual(["prefer bun"]);
    expect(sessionStore.load("codex:sess-1")).not.toBeNull();
    expect(readFileSync(join(stateDir, ".env"), "utf8")).toContain(
      "OPENAI_API_KEY=",
    );
  });

  it("previews without writing and re-runs idempotently", async () => {
    seedAll();
    const preview = await buildImporter().run({
      options: resolveCodexOptions(),
      execute: false,
      overwrite: false,
    });
    expect(preview.summary.migrated).toBe(3);
    expect(existsSync(join(stateDir, "skills", "review"))).toBe(false);
    expect(sessionStore.load("codex:sess-1")).toBeNull();

    await buildImporter().run({
      options: resolveCodexOptions(),
      execute: true,
      overwrite: false,
    });
    const second = await buildImporter().run({
      options: resolveCodexOptions(),
      execute: true,
      overwrite: false,
    });
    expect(second.summary.migrated).toBe(0);
    expect(second.items.every((i) => i.status === "skipped")).toBe(true);
  });

  it("reports empty domains as skipped with a reason", async () => {
    const report = await buildImporter().run({
      options: resolveCodexOptions({ migrateSecrets: true }),
      execute: true,
      overwrite: false,
    });
    expect(report.summary.migrated).toBe(0);
    expect(report.items.map((i) => [i.kind, i.status])).toEqual([
      ["skills", "skipped"],
      ["memory", "skipped"],
      ["sessions", "skipped"],
      ["secrets", "skipped"],
    ]);
  });
});
