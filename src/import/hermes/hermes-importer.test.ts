import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database as DatabaseCtor } from "../../native/load-better-sqlite3.js";
import { SessionStore } from "../../session/index.js";
import { TaskStore } from "../../tasks/index.js";
import { HermesImporter } from "./hermes-importer.js";
import { HermesSource } from "./hermes-source.js";
import { resolveSelectedOptions } from "./import-options.js";

interface SeedSession {
  id: string;
  cwd?: string | null;
  title?: string | null;
  startedAt?: number;
}

interface SeedMessage {
  sessionId: string;
  role: string;
  content?: string | null;
  toolCalls?: string | null;
  toolName?: string | null;
  timestamp?: number;
}

const NOW = Date.parse("2026-06-22T12:00:00Z");

function seedStateDb(
  dir: string,
  sessions: SeedSession[],
  messages: SeedMessage[],
): void {
  const db = new DatabaseCtor(join(dir, "state.db"));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      title TEXT,
      model TEXT,
      started_at REAL NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp REAL NOT NULL,
      reasoning_content TEXT,
      reasoning TEXT
    );
  `);
  const insSession = db.prepare(
    `INSERT INTO sessions (id, cwd, title, model, started_at, archived)
     VALUES (@id, @cwd, @title, @model, @started_at, 0)`,
  );
  for (const s of sessions) {
    insSession.run({
      id: s.id,
      cwd: s.cwd ?? null,
      title: s.title ?? null,
      model: "qwen-3.6",
      started_at: s.startedAt ?? 1_700_000_000,
    });
  }
  const insMessage = db.prepare(
    `INSERT INTO messages (session_id, role, content, tool_calls, tool_name, timestamp)
     VALUES (@session_id, @role, @content, @tool_calls, @tool_name, @timestamp)`,
  );
  for (const m of messages) {
    insMessage.run({
      session_id: m.sessionId,
      role: m.role,
      content: m.content ?? null,
      tool_calls: m.toolCalls ?? null,
      tool_name: m.toolName ?? null,
      timestamp: m.timestamp ?? 1_700_000_001,
    });
  }
  db.close();
}

function writeCronJobs(dir: string, jobs: unknown[]): void {
  mkdirSync(join(dir, "cron"), { recursive: true });
  writeFileSync(
    join(dir, "cron", "jobs.json"),
    JSON.stringify({ jobs, updated_at: "2026-06-11T00:00:00Z" }),
  );
}

describe("HermesImporter", () => {
  let sourceDir: string;
  let stateDir: string;
  let sessionStore: SessionStore;
  let taskStore: TaskStore;
  // Track every source so we can close its (readonly) SQLite handle in
  // teardown; on Windows an open handle keeps state.db locked and rmSync
  // fails with EPERM.
  let sources: HermesSource[] = [];

  function buildImporter(): HermesImporter {
    const source = new HermesSource(sourceDir);
    sources.push(source);
    return new HermesImporter({
      source,
      sessionStore,
      taskStore,
      stateDir,
      maxAttempts: 3,
      workingDirFallback: "/fallback",
      now: () => NOW,
    });
  }

  beforeEach(() => {
    sources = [];
    sourceDir = mkdtempSync(join(tmpdir(), "hermes-src-"));
    stateDir = mkdtempSync(join(tmpdir(), "hermes-dst-"));
    sessionStore = new SessionStore({ dbFile: join(stateDir, "sessions.sqlite") });
    taskStore = new TaskStore({ dbFile: join(stateDir, "tasks.sqlite") });
  });

  afterEach(() => {
    sessionStore.close();
    taskStore.close();
    for (const source of sources) source.close();
    rmSync(sourceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("imports sessions and cron jobs", () => {
    seedStateDb(
      sourceDir,
      [{ id: "s-1", cwd: "/work", title: "t1" }],
      [
        { sessionId: "s-1", role: "user", content: "hi", timestamp: 1_700_000_000 },
        { sessionId: "s-1", role: "assistant", content: "hello", timestamp: 1_700_000_002 },
      ],
    );
    writeCronJobs(sourceDir, [
      { id: "j-1", prompt: "digest", enabled: true, schedule: { kind: "cron", expr: "0 9 * * *" } },
    ]);

    const report = buildImporter().run({
      options: resolveSelectedOptions(),
      execute: true,
      overwrite: false,
    });

    expect(report.summary.migrated).toBe(2);
    expect(report.executed).toBe(true);

    const loaded = sessionStore.load("hermes:s-1");
    expect(loaded?.turns).toHaveLength(2);
    expect(loaded?.workingDir).toBe("/work");

    const tasks = taskStore.list({ limit: 100 });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.userMessage).toBe("digest");
    expect(tasks[0]?.schedule?.kind).toBe("cron");
  });

  it("is idempotent on a second run (skip on match)", () => {
    seedStateDb(
      sourceDir,
      [{ id: "s-1" }],
      [{ sessionId: "s-1", role: "user", content: "hi" }],
    );
    writeCronJobs(sourceDir, [
      { id: "j-1", prompt: "digest", enabled: true, schedule: { kind: "cron", expr: "0 9 * * *" } },
    ]);
    const opts = { options: resolveSelectedOptions(), execute: true, overwrite: false };

    buildImporter().run(opts);
    const second = buildImporter().run(opts);

    expect(second.summary.migrated).toBe(0);
    expect(second.summary.skipped).toBe(2);
    // No duplicate task row.
    expect(taskStore.list({ limit: 100 })).toHaveLength(1);
  });

  it("flags a conflict when a session differs and --overwrite is off", () => {
    seedStateDb(
      sourceDir,
      [{ id: "s-1" }],
      [{ sessionId: "s-1", role: "user", content: "first" }],
    );
    const opts = { options: ["sessions" as const], execute: true, overwrite: false };
    buildImporter().run(opts);

    // Mutate the source so the mapped transcript differs. Close any open
    // source handle first: on Windows the readonly SQLite handle keeps
    // state.db locked and rmSync would fail with EPERM.
    for (const source of sources) source.close();
    rmSync(join(sourceDir, "state.db"), { maxRetries: 5, retryDelay: 100 });
    seedStateDb(
      sourceDir,
      [{ id: "s-1" }],
      [{ sessionId: "s-1", role: "user", content: "changed" }],
    );

    const conflictRun = buildImporter().run(opts);
    expect(conflictRun.summary.conflict).toBe(1);
    expect(sessionStore.load("hermes:s-1")?.turns[0]).toMatchObject({
      text: "first",
    });

    const overwriteRun = buildImporter().run({ ...opts, overwrite: true });
    expect(overwriteRun.summary.migrated).toBe(1);
    expect(sessionStore.load("hermes:s-1")?.turns[0]).toMatchObject({
      text: "changed",
    });
  });

  it("dry-run (execute=false) writes nothing", () => {
    seedStateDb(
      sourceDir,
      [{ id: "s-1" }],
      [{ sessionId: "s-1", role: "user", content: "hi" }],
    );
    writeCronJobs(sourceDir, [
      { id: "j-1", prompt: "digest", enabled: true, schedule: { kind: "cron", expr: "0 9 * * *" } },
    ]);

    const report = buildImporter().run({
      options: resolveSelectedOptions(),
      execute: false,
      overwrite: false,
    });

    expect(report.executed).toBe(false);
    expect(report.summary.migrated).toBe(2);
    expect(sessionStore.load("hermes:s-1")).toBeNull();
    expect(taskStore.list({ limit: 100 })).toHaveLength(0);
  });

  it("respects --limit on sessions", () => {
    seedStateDb(
      sourceDir,
      [
        { id: "s-1", startedAt: 1_700_000_000 },
        { id: "s-2", startedAt: 1_700_000_100 },
      ],
      [
        { sessionId: "s-1", role: "user", content: "a" },
        { sessionId: "s-2", role: "user", content: "b" },
      ],
    );
    const report = buildImporter().run({
      options: ["sessions"],
      execute: true,
      overwrite: false,
      limit: 1,
    });
    expect(report.summary.migrated).toBe(1);
    expect(sessionStore.load("hermes:s-1")).not.toBeNull();
    expect(sessionStore.load("hermes:s-2")).toBeNull();
  });

  describe("secrets", () => {
    it("does not touch secrets without the secrets option", () => {
      seedStateDb(sourceDir, [{ id: "s-1" }], []);
      writeFileSync(join(sourceDir, ".env"), "OPENROUTER_API_KEY=sk-or-abc\n");

      const report = buildImporter().run({
        options: resolveSelectedOptions(),
        execute: true,
        overwrite: false,
      });
      expect(report.items.some((i) => i.kind === "secrets")).toBe(false);
    });

    it("migrates a new provider key and never leaks its value", () => {
      seedStateDb(sourceDir, [{ id: "s-1" }], []);
      writeFileSync(join(sourceDir, ".env"), "OPENROUTER_API_KEY=sk-or-secret\n");

      const report = buildImporter().run({
        options: resolveSelectedOptions({ migrateSecrets: true }),
        execute: true,
        overwrite: false,
      });

      const secretItem = report.items.find((i) => i.kind === "secrets");
      expect(secretItem).toMatchObject({
        kind: "secrets",
        source: "OPENROUTER_API_KEY",
        status: "migrated",
      });
      expect(JSON.stringify(report)).not.toContain("sk-or-secret");

      const envText = readFileSync(join(stateDir, ".env"), "utf8");
      expect(envText).toContain("OPENROUTER_API_KEY=sk-or-secret");
    });

    it("skips when the key already has the same value", () => {
      seedStateDb(sourceDir, [{ id: "s-1" }], []);
      writeFileSync(join(sourceDir, ".env"), "OPENROUTER_API_KEY=same\n");
      writeFileSync(join(stateDir, ".env"), "OPENROUTER_API_KEY=same\n");

      const report = buildImporter().run({
        options: resolveSelectedOptions({ migrateSecrets: true }),
        execute: true,
        overwrite: false,
      });
      expect(report.items.find((i) => i.kind === "secrets")?.status).toBe(
        "skipped",
      );
    });

    it("conflicts when the key differs and --overwrite is off, overwrites when on", () => {
      seedStateDb(sourceDir, [{ id: "s-1" }], []);
      writeFileSync(join(sourceDir, ".env"), "OPENROUTER_API_KEY=new\n");
      writeFileSync(join(stateDir, ".env"), "OPENROUTER_API_KEY=old\n");
      const opts = {
        options: resolveSelectedOptions({ migrateSecrets: true }),
        execute: true,
        overwrite: false,
      };

      const conflict = buildImporter().run(opts);
      expect(conflict.items.find((i) => i.kind === "secrets")?.status).toBe(
        "conflict",
      );
      expect(readFileSync(join(stateDir, ".env"), "utf8")).toContain(
        "OPENROUTER_API_KEY=old",
      );

      const overwrite = buildImporter().run({ ...opts, overwrite: true });
      expect(overwrite.items.find((i) => i.kind === "secrets")?.status).toBe(
        "migrated",
      );
      expect(readFileSync(join(stateDir, ".env"), "utf8")).toContain(
        "OPENROUTER_API_KEY=new",
      );
    });

    it("reports skipped when no migratable key exists", () => {
      seedStateDb(sourceDir, [{ id: "s-1" }], []);
      writeFileSync(join(sourceDir, ".env"), "ANTHROPIC_API_KEY=x\n");

      const report = buildImporter().run({
        options: resolveSelectedOptions({ migrateSecrets: true }),
        execute: true,
        overwrite: false,
      });
      const secretItem = report.items.find((i) => i.kind === "secrets");
      expect(secretItem?.status).toBe("skipped");
    });
  });
});
