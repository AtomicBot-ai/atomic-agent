import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore, ProfileStore } from "../../memory/index.js";
import { Database as DatabaseCtor } from "../../native/load-better-sqlite3.js";
import {
  INTERRUPTED_TURN_ENDING,
  SessionStore,
  createEmptySessionState,
} from "../../session/index.js";
import { TaskStore } from "../../tasks/index.js";
import {
  checkAtomicDesktopSource,
  importAtomicDesktop,
  type AtomicDesktopImportTargets,
} from "./atomic-desktop-importer.js";

/** One state dir's four stores, as a runtime opens them. */
interface StateStores extends AtomicDesktopImportTargets {
  close(): void;
}

function openStores(dir: string): StateStores {
  const sessionStore = new SessionStore({
    dbFile: join(dir, "sessions.sqlite"),
  });
  const taskStore = new TaskStore({ dbFile: join(dir, "tasks.sqlite") });
  const memoryStore = new MemoryStore({
    dbFile: join(dir, "memory.sqlite"),
    maxEntries: 1_000,
  });
  const profileStore = new ProfileStore({ dbFile: join(dir, "memory.sqlite") });
  return {
    sessionStore,
    taskStore,
    memoryStore,
    profileStore,
    close() {
      profileStore.close();
      memoryStore.close();
      taskStore.close();
      sessionStore.close();
    },
  };
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The source's database and WAL files with their content hashes. */
function sourceFingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith(".sqlite") || name.endsWith(".sqlite-wal")) {
      out[name] = hashFile(join(dir, name));
    }
  }
  return out;
}

describe("importAtomicDesktop", () => {
  let root: string;
  let sourceDir: string;
  let targetDir: string;
  let source: StateStores | null;
  let target: StateStores;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "atomic-desktop-import-test-"));
    sourceDir = join(root, "desktop");
    targetDir = join(root, "agent");
    mkdirSync(sourceDir);
    mkdirSync(targetDir);
    source = openStores(sourceDir);
    target = openStores(targetDir);
  });

  afterEach(() => {
    source?.close();
    target.close();
    rmSync(root, { recursive: true, force: true });
  });

  function closeSource(): void {
    source?.close();
    source = null;
  }

  function src(): StateStores {
    if (source === null) throw new Error("source already closed");
    return source;
  }

  function run(extra: { batchSize?: number } = {}) {
    return importAtomicDesktop({
      sourceDir,
      targetStateDir: targetDir,
      targets: target,
      scratchParent: root,
      ...extra,
    });
  }

  describe("sessions", () => {
    it("copies sessions by id and keeps the target's row on the same id", async () => {
      src().sessionStore.save({
        ...createEmptySessionState({ id: "s-only-desktop", workingDir: "/d" }),
        status: "completed",
      });
      src().sessionStore.save(
        createEmptySessionState({ id: "s-shared", workingDir: "/desktop" }),
      );
      target.sessionStore.save(
        createEmptySessionState({ id: "s-shared", workingDir: "/terminal" }),
      );
      closeSource();

      const result = await run();

      expect(result.ok).toBe(true);
      expect(result.sessions).toEqual({ imported: 1, skipped: 1 });
      const copied = target.sessionStore.load("s-only-desktop");
      expect(copied?.workingDir).toBe("/d");
      expect(copied?.status).toBe("completed");
      expect(target.sessionStore.load("s-shared")?.workingDir).toBe(
        "/terminal",
      );
    });

    it("ends a live turn and never copies its owner mark", async () => {
      src().sessionStore.save(
        createEmptySessionState({ id: "s-live", workingDir: "/d" }),
      );
      expect(src().sessionStore.beginTurn("s-live")).toBe(true);
      closeSource();

      const result = await run();

      expect(result.sessions.imported).toBe(1);
      const copied = target.sessionStore.load("s-live");
      expect(copied?.status).toBe(INTERRUPTED_TURN_ENDING.status);
      expect(copied?.lastError).toBe(INTERRUPTED_TURN_ENDING.lastError);
      const raw = new DatabaseCtor(join(targetDir, "sessions.sqlite"), {
        readonly: true,
      });
      try {
        const row = raw
          .prepare(`SELECT status, turn_owner FROM sessions WHERE id = ?`)
          .get("s-live") as { status: string; turn_owner: string | null };
        expect(row).toEqual({
          status: INTERRUPTED_TURN_ENDING.status,
          turn_owner: null,
        });
      } finally {
        raw.close();
      }
    });

    it("reads rows still in the source's WAL while another process holds it open", async () => {
      for (let i = 0; i < 5; i += 1) {
        src().sessionStore.save(
          createEmptySessionState({ id: `s-wal-${i}`, workingDir: "/d" }),
        );
      }
      // The source stays open: its writes sit in sessions.sqlite-wal.
      expect(existsSync(join(sourceDir, "sessions.sqlite-wal"))).toBe(true);
      const before = sourceFingerprint(sourceDir);

      const result = await run({ batchSize: 2 });

      expect(result.sessions).toEqual({ imported: 5, skipped: 0 });
      expect(sourceFingerprint(sourceDir)).toEqual(before);
      expect(src().sessionStore.load("s-wal-4")).not.toBeNull();
    });

    it("skips and reports a source row whose payload does not parse", async () => {
      src().sessionStore.save(
        createEmptySessionState({ id: "s-good", workingDir: "/d" }),
      );
      closeSource();
      const raw = new DatabaseCtor(join(sourceDir, "sessions.sqlite"));
      raw
        .prepare(
          `INSERT INTO sessions (id, working_dir, status, payload, created_at, updated_at)
           VALUES ('s-bad', '/d', 'completed', '{not json', 1, 1)`,
        )
        .run();
      raw.close();

      const result = await run();

      expect(result.ok).toBe(true);
      expect(result.sessions).toEqual({ imported: 1, skipped: 1 });
      expect(result.warnings.join("\n")).toMatch(/could not be read/);
      expect(target.sessionStore.load("s-bad")).toBeNull();
    });
  });

  describe("tasks", () => {
    it("copies pending, running and terminal tasks; a running one arrives pending without an owner", async () => {
      const store = src().taskStore;
      store.create({
        id: "t-pending",
        userMessage: "later",
        origin: "scheduler",
        maxAttempts: 3,
        schedule: { kind: "cron", expression: "0 9 * * *" },
        scheduledFor: 4_102_444_800_000,
      });
      store.create({
        id: "t-running",
        userMessage: "now",
        origin: "tui",
        maxAttempts: 3,
      });
      expect(store.markRunning("t-running")).not.toBeNull();
      store.create({
        id: "t-done",
        userMessage: "done",
        origin: "cli",
        maxAttempts: 1,
      });
      store.markRunning("t-done");
      store.markCompleted("t-done");
      store.create({
        id: "t-shared",
        userMessage: "desktop copy",
        origin: "cli",
        maxAttempts: 1,
      });
      target.taskStore.create({
        id: "t-shared",
        userMessage: "terminal copy",
        origin: "cli",
        maxAttempts: 1,
      });
      closeSource();

      const result = await run();

      expect(result.ok).toBe(true);
      expect(result.tasks).toEqual({ imported: 3, skipped: 1 });
      const pending = target.taskStore.get("t-pending");
      expect(pending?.status).toBe("pending");
      expect(pending?.schedule).toEqual({
        kind: "cron",
        expression: "0 9 * * *",
      });
      expect(pending?.recurring).toBe(true);
      expect(pending?.scheduledFor).toBe(4_102_444_800_000);
      const running = target.taskStore.get("t-running");
      expect(running?.status).toBe("pending");
      expect(running?.startedAt).toBeNull();
      expect(running?.attempts).toBe(1);
      expect(target.taskStore.get("t-done")?.status).toBe("completed");
      expect(target.taskStore.get("t-shared")?.userMessage).toBe(
        "terminal copy",
      );
      const raw = new DatabaseCtor(join(targetDir, "tasks.sqlite"), {
        readonly: true,
      });
      try {
        const owners = raw
          .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE run_owner IS NOT NULL`)
          .get() as { n: number };
        expect(owners.n).toBe(0);
      } finally {
        raw.close();
      }
    });

    it("reports a source queue newer than this binary and still imports the rest", async () => {
      src().sessionStore.save(
        createEmptySessionState({ id: "s-1", workingDir: "/d" }),
      );
      src().taskStore.create({
        id: "t-1",
        userMessage: "x",
        origin: "cli",
        maxAttempts: 1,
      });
      closeSource();
      const raw = new DatabaseCtor(join(sourceDir, "tasks.sqlite"));
      raw.prepare(`UPDATE schema_meta SET value = '999' WHERE key = 'version'`).run();
      raw.close();

      const result = await run();

      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toMatch(/^tasks: .*newer/m);
      expect(result.sessions.imported).toBe(1);
      expect(target.taskStore.get("t-1")).toBeNull();
    });
  });

  describe("memory", () => {
    it("adds notes through the store with exact-content dedup, keeping their fields", async () => {
      src().memoryStore.store(
        {
          content: "prefers dark mode",
          tags: ["ui"],
          sessionId: "s-1",
          workingDir: "/proj",
          source: "user",
        },
        1_000,
      );
      src().memoryStore.store({ content: "already known" }, 2_000);
      target.memoryStore.store({ content: "already known" }, 3_000);
      closeSource();

      const result = await run();

      expect(result.ok).toBe(true);
      expect(result.notes).toEqual({ imported: 1, skipped: 1 });
      const notes = target.memoryStore.list({ scope: "all", limit: 50 });
      expect(notes.map((n) => n.content).sort()).toEqual([
        "already known",
        "prefers dark mode",
      ]);
      const copied = notes.find((n) => n.content === "prefers dark mode");
      expect(copied).toMatchObject({
        tags: ["ui"],
        sessionId: "s-1",
        workingDir: "/proj",
        source: "user",
        updatedAt: 1_000,
      });
    });

    it("lets the target's profile value win on the same key", async () => {
      src().profileStore.set("name", "Desk", {}, 1_000);
      src().profileStore.set("editor", "vim", {}, 1_000);
      src().profileStore.set("city", "Lisbon", {}, 1_000);
      src().profileStore.set(
        "coffee",
        "flat white",
        { pinned: false, keywords: ["coffee"] },
        1_000,
      );
      target.profileStore.set("editor", "emacs", {}, 2_000);
      // Changed and then removed here: its history says the key is the
      // target's, so the desktop's value does not come back.
      target.profileStore.set("city", "Porto", {}, 2_000);
      target.profileStore.set("city", "Braga", {}, 3_000);
      target.profileStore.remove("city");
      closeSource();

      const result = await run();

      expect(result.ok).toBe(true);
      expect(result.profileFacts).toEqual({ imported: 2, skipped: 2 });
      expect(target.profileStore.get("editor")?.value).toBe("emacs");
      expect(target.profileStore.get("city")).toBeNull();
      expect(target.profileStore.get("name")?.value).toBe("Desk");
      expect(target.profileStore.get("coffee")).toMatchObject({
        value: "flat white",
        pinned: false,
        keywords: ["coffee"],
      });
    });

    it("leaves lessons, votes and embeddings behind", async () => {
      src().memoryStore.store({ content: "a note" });
      closeSource();
      const raw = new DatabaseCtor(join(sourceDir, "memory.sqlite"));
      raw
        .prepare(
          `INSERT INTO lessons (activation, principle, parent_ids, status, created_at, updated_at)
           VALUES ('when x', 'do y', '[1]', 'active', 1, 1)`,
        )
        .run();
      raw.close();

      const result = await run();

      expect(result.ok).toBe(true);
      const check = new DatabaseCtor(join(targetDir, "memory.sqlite"), {
        readonly: true,
      });
      try {
        const count = (table: string): number =>
          (check.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
            n: number;
          }).n;
        expect(count("memories")).toBe(1);
        expect(count("lessons")).toBe(0);
        expect(count("memory_embeddings")).toBe(0);
      } finally {
        check.close();
      }
    });
  });

  it("imports nothing new on a second run", async () => {
    src().sessionStore.save(
      createEmptySessionState({ id: "s-1", workingDir: "/d" }),
    );
    src().taskStore.create({
      id: "t-1",
      userMessage: "x",
      origin: "cli",
      maxAttempts: 1,
    });
    src().memoryStore.store({ content: "note one" });
    src().memoryStore.store({ content: "note two" });
    src().profileStore.set("name", "Desk");
    closeSource();

    const first = await run();
    expect(first.ok).toBe(true);
    expect(first.sessions.imported).toBe(1);
    expect(first.tasks.imported).toBe(1);
    expect(first.notes.imported).toBe(2);
    expect(first.profileFacts.imported).toBe(1);

    const second = await run();
    expect(second.ok).toBe(true);
    expect(second.sessions).toEqual({ imported: 0, skipped: 1 });
    expect(second.tasks).toEqual({ imported: 0, skipped: 1 });
    expect(second.notes).toEqual({ imported: 0, skipped: 2 });
    expect(second.profileFacts).toEqual({ imported: 0, skipped: 1 });
    expect(target.memoryStore.count()).toBe(2);
  });

  it("never writes the source", async () => {
    src().sessionStore.save(
      createEmptySessionState({ id: "s-1", workingDir: "/d" }),
    );
    src().taskStore.create({
      id: "t-1",
      userMessage: "x",
      origin: "cli",
      maxAttempts: 1,
    });
    src().memoryStore.store({ content: "note" });
    src().profileStore.set("name", "Desk");
    closeSource();
    const before = sourceFingerprint(sourceDir);
    const names = readdirSync(sourceDir).sort();

    await run();

    expect(sourceFingerprint(sourceDir)).toEqual(before);
    // Closed cleanly, so copied rather than opened: no -wal/-shm appear.
    expect(readdirSync(sourceDir).sort()).toEqual(names);
  });

  it("warns about a database the source does not have", async () => {
    closeSource();
    rmSync(join(sourceDir, "tasks.sqlite"));
    rmSync(join(sourceDir, "memory.sqlite"));

    const result = await run();

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      "no tasks.sqlite in the source; no tasks to import",
      "no memory.sqlite in the source; no memory to import",
    ]);
  });

  it("refuses a source that is missing or is the target itself", async () => {
    expect(checkAtomicDesktopSource(join(root, "nope"), targetDir)).toMatch(
      /does not exist/,
    );
    expect(checkAtomicDesktopSource(targetDir, targetDir)).toMatch(
      /is the target/,
    );
    const result = await importAtomicDesktop({
      sourceDir: targetDir,
      targetStateDir: targetDir,
      targets: target,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/is the target/);
  });

  it("removes its snapshots", async () => {
    closeSource();
    await run();
    expect(
      readdirSync(root).filter((n) => n.startsWith("atomic-desktop-import-")),
    ).toEqual([]);
  });
});
