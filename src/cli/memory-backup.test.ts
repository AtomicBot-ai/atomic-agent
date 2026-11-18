import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../native/load-better-sqlite3.js";
import { MemoryStore } from "../memory/memory-store.js";
import { ProfileStore } from "../memory/profile-store.js";
import { defaultBackupDir, restoreCommandFor, runMemoryBackup } from "./memory-backup.js";

let dir: string;
let dbFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-backup-"));
  dbFile = join(dir, "memory.sqlite");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function quiet() {
  const lines: string[] = [];
  return { lines, out: (t: string) => void lines.push(t), err: (t: string) => void lines.push(t) };
}

describe("atomic-agent memory backup (ATO-46)", () => {
  it("copies notes and facts while the stores are open, and says how to restore", async () => {
    const notes = new MemoryStore({ dbFile, maxEntries: 100 });
    const profile = new ProfileStore({ dbFile });
    notes.store({ content: "The person ships on Fridays", tags: [], source: "user" });
    profile.set("city", "Lisbon");
    const out = join(dir, "bk");
    const io = quiet();
    expect(await runMemoryBackup(out, { memoryDbFile: dbFile, stateDir: dir, ...io })).toBe(0);
    notes.close();
    profile.close();

    const copy = new Database(join(out, "memory.sqlite"), { readonly: true });
    try {
      const tables = (copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
      expect(tables.length).toBeGreaterThan(0);
    } finally {
      copy.close();
    }
    const copyNotes = new MemoryStore({ dbFile: join(out, "memory.sqlite"), maxEntries: 100 });
    expect(copyNotes.hasContent("The person ships on Fridays")).toBe(true);
    copyNotes.close();
    expect(readFileSync(join(out, "RESTORE.txt"), "utf8")).toContain(restoreCommandFor(out));
    expect(io.lines.join("")).toContain("--include memory");
  });

  it("never overwrites an earlier backup", async () => {
    new MemoryStore({ dbFile, maxEntries: 10 }).close();
    const out = join(dir, "bk");
    expect(await runMemoryBackup(out, { memoryDbFile: dbFile, stateDir: dir, ...quiet() })).toBe(0);
    expect(await runMemoryBackup(out, { memoryDbFile: dbFile, stateDir: dir, ...quiet() })).toBe(2);
  });

  it("no memory yet is a plain failure; the default folder sits under the state dir", async () => {
    expect(await runMemoryBackup(join(dir, "x"), { memoryDbFile: join(dir, "nope.sqlite"), stateDir: dir, ...quiet() })).toBe(1);
    expect(existsSync(join(dir, "x"))).toBe(false);
    expect(defaultBackupDir("/s", new Date(2026, 10, 18, 9, 5, 7))).toBe("/s/backups/memory-20261118-090507");
  });
});
