import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { SessionStore } from "./session-store.js";
import { createEmptySessionState } from "./session-state.js";
import { readRecentWorkingDirs } from "./recent-working-dirs.js";

describe("readRecentWorkingDirs", () => {
  let tmp: string;
  let dbFile: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-recent-dirs-"));
    dbFile = join(tmp, "sessions.sqlite");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the working dirs newest first, capped at the limit", () => {
    const store = new SessionStore({ dbFile });
    store.save({ ...createEmptySessionState({ id: "a", workingDir: "/w1" }), updatedAt: 1000 });
    store.save({ ...createEmptySessionState({ id: "b", workingDir: "/w2" }), updatedAt: 3000 });
    store.save({ ...createEmptySessionState({ id: "c", workingDir: "/w3" }), updatedAt: 2000 });
    store.close();

    expect(readRecentWorkingDirs(dbFile, 2)).toEqual(["/w2", "/w3"]);
  });

  it("reads as no history when the database file does not exist", () => {
    expect(readRecentWorkingDirs(join(tmp, "missing.sqlite"))).toEqual([]);
  });

  it("reads as no history when the file is not a database", () => {
    writeFileSync(dbFile, "not sqlite at all");
    expect(readRecentWorkingDirs(dbFile)).toEqual([]);
  });

  it("reads as no history when the sessions table is absent, and creates nothing", () => {
    const raw = new DatabaseCtor(dbFile);
    raw.exec("CREATE TABLE other (x INTEGER)");
    raw.close();

    expect(readRecentWorkingDirs(dbFile)).toEqual([]);
    const check = new DatabaseCtor(dbFile, { readonly: true });
    const tables = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    check.close();
    expect(tables.map((t) => t.name)).toEqual(["other"]);
  });
});
