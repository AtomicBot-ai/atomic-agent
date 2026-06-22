import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database as DatabaseCtor } from "../../native/load-better-sqlite3.js";
import { SessionStore } from "../../session/index.js";
import { TaskStore } from "../../tasks/index.js";
import { OpenclawImporter } from "./openclaw-importer.js";
import { OpenclawSource } from "./openclaw-source.js";
import { resolveOpenclawOptions } from "./import-options.js";

const NOW = Date.parse("2026-06-22T12:00:00Z");

interface SeedCronJob {
  job_id: string;
  payload_message: string;
  enabled?: number;
  schedule_kind?: string;
  schedule_expr?: string | null;
  schedule_tz?: string | null;
  every_ms?: number | null;
  at?: string | null;
  agent_id?: string | null;
}

/** Write a session JSONL log with a `session` header + message events. */
function writeSession(
  sourceDir: string,
  agent: string,
  id: string,
  events: unknown[],
  startedAt = "2026-06-11T13:00:00.000Z",
): void {
  const dir = join(sourceDir, "agents", agent, "sessions");
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "session", version: 3, id, timestamp: startedAt, cwd: "/work" },
    { type: "model_change", modelId: "qwen-3.6-35b-a3b", timestamp: startedAt },
    ...events,
  ];
  writeFileSync(
    join(dir, `${id}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

function messageEvent(
  role: string,
  content: unknown[],
  atMs: number,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    type: "message",
    id: Math.random().toString(36).slice(2),
    timestamp: new Date(atMs).toISOString(),
    message: { role, content, timestamp: atMs, ...extra },
  };
}

function seedCronTable(sourceDir: string, jobs: SeedCronJob[]): void {
  const dir = join(sourceDir, "state");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseCtor(join(dir, "openclaw.sqlite"));
  db.exec(`
    CREATE TABLE cron_jobs (
      store_key TEXT NOT NULL,
      job_id TEXT NOT NULL,
      name TEXT,
      enabled INTEGER NOT NULL,
      schedule_kind TEXT NOT NULL,
      schedule_expr TEXT,
      schedule_tz TEXT,
      every_ms INTEGER,
      at TEXT,
      payload_message TEXT,
      agent_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (store_key, job_id)
    );
  `);
  const ins = db.prepare(
    `INSERT INTO cron_jobs
       (store_key, job_id, name, enabled, schedule_kind, schedule_expr,
        schedule_tz, every_ms, at, payload_message, agent_id, sort_order)
     VALUES (@store_key, @job_id, @name, @enabled, @schedule_kind, @schedule_expr,
        @schedule_tz, @every_ms, @at, @payload_message, @agent_id, @sort_order)`,
  );
  jobs.forEach((j, i) => {
    ins.run({
      store_key: "agent:main",
      job_id: j.job_id,
      name: null,
      enabled: j.enabled ?? 1,
      schedule_kind: j.schedule_kind ?? "cron",
      schedule_expr: j.schedule_expr ?? "0 9 * * *",
      schedule_tz: j.schedule_tz ?? null,
      every_ms: j.every_ms ?? null,
      at: j.at ?? null,
      payload_message: j.payload_message,
      agent_id: j.agent_id ?? "main",
      sort_order: i,
    });
  });
  db.close();
}

describe("OpenclawImporter", () => {
  let sourceDir: string;
  let stateDir: string;
  let sessionStore: SessionStore;
  let taskStore: TaskStore;

  function buildImporter(): OpenclawImporter {
    return new OpenclawImporter({
      source: new OpenclawSource(sourceDir, "main"),
      sessionStore,
      taskStore,
      maxAttempts: 3,
      workingDirFallback: "/fallback",
      now: () => NOW,
    });
  }

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "oc-src-"));
    stateDir = mkdtempSync(join(tmpdir(), "oc-dst-"));
    sessionStore = new SessionStore({ dbFile: join(stateDir, "sessions.sqlite") });
    taskStore = new TaskStore({ dbFile: join(stateDir, "tasks.sqlite") });
  });

  afterEach(() => {
    sessionStore.close();
    taskStore.close();
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("imports sessions and cron jobs", () => {
    writeSession(sourceDir, "main", "gaia-1", [
      messageEvent("user", [{ type: "text", text: "hi" }], 1_700_000_000_000),
      messageEvent("assistant", [{ type: "text", text: "hello" }], 1_700_000_002_000),
    ]);
    seedCronTable(sourceDir, [{ job_id: "j-1", payload_message: "digest" }]);

    const report = buildImporter().run({
      options: resolveOpenclawOptions(),
      execute: true,
      overwrite: false,
    });

    expect(report.summary.migrated).toBe(2);
    expect(report.executed).toBe(true);

    const loaded = sessionStore.load("openclaw:gaia-1");
    expect(loaded?.turns).toHaveLength(2);
    expect(loaded?.workingDir).toBe("/work");

    const tasks = taskStore.list({ limit: 100 });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.userMessage).toBe("digest");
    expect(tasks[0]?.schedule?.kind).toBe("cron");
  });

  it("ignores .trajectory.jsonl logs", () => {
    writeSession(sourceDir, "main", "gaia-1", [
      messageEvent("user", [{ type: "text", text: "hi" }], 1_700_000_000_000),
    ]);
    // A stray trajectory file must not be imported as a session.
    const dir = join(sourceDir, "agents", "main", "sessions");
    writeFileSync(
      join(dir, "gaia-1.trajectory.jsonl"),
      JSON.stringify({ type: "session", id: "gaia-1-traj", timestamp: "2026-06-11T13:00:00.000Z" }) + "\n",
    );

    const report = buildImporter().run({
      options: ["sessions"],
      execute: true,
      overwrite: false,
    });
    expect(report.summary.migrated).toBe(1);
    expect(sessionStore.load("openclaw:gaia-1-traj")).toBeNull();
  });

  it("is idempotent on a second run (skip on match)", () => {
    writeSession(sourceDir, "main", "gaia-1", [
      messageEvent("user", [{ type: "text", text: "hi" }], 1_700_000_000_000),
    ]);
    seedCronTable(sourceDir, [{ job_id: "j-1", payload_message: "digest" }]);
    const opts = { options: resolveOpenclawOptions(), execute: true, overwrite: false };

    buildImporter().run(opts);
    const second = buildImporter().run(opts);

    expect(second.summary.migrated).toBe(0);
    expect(second.summary.skipped).toBe(2);
    expect(taskStore.list({ limit: 100 })).toHaveLength(1);
  });

  it("dry-run writes nothing", () => {
    writeSession(sourceDir, "main", "gaia-1", [
      messageEvent("user", [{ type: "text", text: "hi" }], 1_700_000_000_000),
    ]);
    seedCronTable(sourceDir, [{ job_id: "j-1", payload_message: "digest" }]);

    const report = buildImporter().run({
      options: resolveOpenclawOptions(),
      execute: false,
      overwrite: false,
    });
    expect(report.executed).toBe(false);
    expect(report.summary.migrated).toBe(2);
    expect(sessionStore.load("openclaw:gaia-1")).toBeNull();
    expect(taskStore.list({ limit: 100 })).toHaveLength(0);
  });

  it("respects --limit on sessions (oldest first)", () => {
    writeSession(
      sourceDir,
      "main",
      "gaia-old",
      [messageEvent("user", [{ type: "text", text: "a" }], 1_700_000_000_000)],
      "2026-06-11T10:00:00.000Z",
    );
    writeSession(
      sourceDir,
      "main",
      "gaia-new",
      [messageEvent("user", [{ type: "text", text: "b" }], 1_700_000_100_000)],
      "2026-06-11T11:00:00.000Z",
    );

    const report = buildImporter().run({
      options: ["sessions"],
      execute: true,
      overwrite: false,
      limit: 1,
    });
    expect(report.summary.migrated).toBe(1);
    expect(sessionStore.load("openclaw:gaia-old")).not.toBeNull();
    expect(sessionStore.load("openclaw:gaia-new")).toBeNull();
  });

  it("skips sessions cleanly when the agent dir is absent", () => {
    const report = buildImporter().run({
      options: ["sessions"],
      execute: true,
      overwrite: false,
    });
    expect(report.summary.skipped).toBe(1);
    expect(report.items[0]).toMatchObject({ kind: "sessions", status: "skipped" });
  });
});
