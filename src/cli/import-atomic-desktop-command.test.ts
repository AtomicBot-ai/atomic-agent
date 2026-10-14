import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../config/index.js";
import { MemoryStore, ProfileStore } from "../memory/index.js";
import { SessionStore, createEmptySessionState } from "../session/index.js";
import { TaskStore } from "../tasks/index.js";

import { importCommand } from "./import-command.js";

describe("import atomic-desktop", () => {
  let root: string;
  let sourceDir: string;
  let stateDir: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "atomic-desktop-cli-"));
    sourceDir = join(root, "desktop");
    stateDir = join(root, "agent");
    mkdirSync(sourceDir);
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    stdoutChunks = [];
    stderrChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  });

  function seedSource(): void {
    const sessions = new SessionStore({
      dbFile: join(sourceDir, "sessions.sqlite"),
    });
    sessions.save(createEmptySessionState({ id: "s-1", workingDir: "/d" }));
    sessions.close();
    const tasks = new TaskStore({ dbFile: join(sourceDir, "tasks.sqlite") });
    tasks.create({ id: "t-1", userMessage: "x", origin: "cli", maxAttempts: 1 });
    tasks.close();
    const notes = new MemoryStore({
      dbFile: join(sourceDir, "memory.sqlite"),
      maxEntries: 100,
    });
    notes.store({ content: "a desktop note" });
    notes.close();
    const profile = new ProfileStore({
      dbFile: join(sourceDir, "memory.sqlite"),
    });
    profile.set("editor", "vim");
    profile.close();
  }

  function lastJson(): Record<string, unknown> {
    const lines = stdoutChunks.join("").trim().split("\n");
    return JSON.parse(lines[lines.length - 1] as string) as Record<
      string,
      unknown
    >;
  }

  it("prints one JSON object and exits 0, then imports nothing new", async () => {
    seedSource();

    const code = await importCommand([
      "atomic-desktop",
      "--source",
      sourceDir,
      "--json",
    ]);

    expect(code).toBe(0);
    expect(lastJson()).toEqual({
      ok: true,
      sessions: { imported: 1, skipped: 0 },
      tasks: { imported: 1, skipped: 0 },
      notes: { imported: 1, skipped: 0 },
      profileFacts: { imported: 1, skipped: 0 },
      warnings: [],
    });

    stdoutChunks.length = 0;
    expect(
      await importCommand(["atomic-desktop", "--source", sourceDir, "--json"]),
    ).toBe(0);
    expect(lastJson()).toMatchObject({
      ok: true,
      sessions: { imported: 0, skipped: 1 },
      tasks: { imported: 0, skipped: 1 },
      notes: { imported: 0, skipped: 1 },
      profileFacts: { imported: 0, skipped: 1 },
    });
  });

  it("prints a human summary without --json", async () => {
    seedSource();

    const code = await importCommand(["atomic-desktop", "--source", sourceDir]);

    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    expect(out).toMatch(/sessions\s+1 imported, 0 skipped/);
    expect(out).toMatch(/not imported: lessons/);
  });

  it("fails with a clear message when --source is missing", async () => {
    const code = await importCommand(["atomic-desktop", "--json"]);

    expect(code).toBe(1);
    expect(lastJson()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/--source/),
    });
    expect(stderrChunks.join("")).toMatch(/--source/);
  });

  it("fails without creating the target databases when the source does not exist", async () => {
    const code = await importCommand([
      "atomic-desktop",
      "--source",
      join(root, "missing"),
      "--json",
    ]);

    expect(code).toBe(1);
    expect(lastJson()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/does not exist/),
    });
    expect(existsSync(join(stateDir, "sessions.sqlite"))).toBe(false);
  });

  it("is listed in the import help", async () => {
    await importCommand(["--help"]);
    expect(stdoutChunks.join("")).toMatch(/atomic-desktop --source <dir>/);
  });
});
