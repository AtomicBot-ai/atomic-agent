import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache, getConfig } from "../config/index.js";
import { TaskStore } from "../tasks/index.js";

import { taskCommand } from "./task-command.js";

/**
 * The `run` subcommand is exercised end-to-end by `route-tasks.test.ts`
 * and `task-runner.test.ts` — it spins up `createAgentRuntime` against
 * the real browser/llama wiring and is intentionally out of scope for
 * this CLI suite. Everything else (list / show / create / cancel /
 * help) is a pure round-trip through `TaskStore`, which we verify here
 * against a real SQLite file in a tmp state dir.
 */
describe("taskCommand", () => {
  let stateDir: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-task-cli-"));
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
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  function stdout(): string {
    return stdoutChunks.join("");
  }

  function stderr(): string {
    return stderrChunks.join("");
  }

  it("prints help when no subcommand is passed", async () => {
    const code = await taskCommand([]);
    expect(code).toBe(0);
    expect(stdout()).toMatch(/atomic-agent task/);
    expect(stdout()).toMatch(/list \[--session/);
  });

  it("rejects unknown subcommand", async () => {
    const code = await taskCommand(["nope"]);
    expect(code).toBe(1);
    expect(stderr()).toMatch(/unknown subcommand: nope/);
  });

  it("create persists a task that show / list / cancel can round-trip", async () => {
    const createCode = await taskCommand([
      "create",
      "--session",
      "s-cli-1",
      "--message",
      "do the thing",
      "--max-attempts",
      "5",
    ]);
    expect(createCode).toBe(0);
    const created = JSON.parse(stdout());
    expect(created.sessionId).toBe("s-cli-1");
    expect(created.userMessage).toBe("do the thing");
    expect(created.maxAttempts).toBe(5);
    expect(created.status).toBe("pending");
    expect(created.origin).toBe("cli");

    stdoutChunks.length = 0;
    const showCode = await taskCommand(["show", created.id]);
    expect(showCode).toBe(0);
    const shown = JSON.parse(stdout());
    expect(shown.id).toBe(created.id);
    expect(shown.status).toBe("pending");

    stdoutChunks.length = 0;
    const listCode = await taskCommand(["list", "--status", "pending"]);
    expect(listCode).toBe(0);
    expect(stdout()).toContain(created.id);
    expect(stdout()).toContain("do the thing");

    stdoutChunks.length = 0;
    const cancelCode = await taskCommand(["cancel", created.id]);
    expect(cancelCode).toBe(0);
    const cancelled = JSON.parse(stdout());
    expect(cancelled.status).toBe("cancelled");

    const store = new TaskStore({ dbFile: getConfig().paths.tasksDbFile });
    try {
      const fromDb = store.get(created.id);
      expect(fromDb?.status).toBe("cancelled");
    } finally {
      store.close();
    }
  });

  it("create --notify telegram persists the opt-in; default stays null", async () => {
    const code = await taskCommand([
      "create",
      "--session",
      "s-cli-2",
      "--message",
      "digest",
      "--notify",
      "telegram",
    ]);
    expect(code).toBe(0);
    const created = JSON.parse(stdout());
    expect(created.notify).toBe("telegram");

    stdoutChunks.length = 0;
    const silentCode = await taskCommand([
      "create",
      "--session",
      "s-cli-2",
      "--message",
      "quiet",
    ]);
    expect(silentCode).toBe(0);
    expect(JSON.parse(stdout()).notify).toBeNull();
  });

  it("create rejects an unknown --notify target", async () => {
    const code = await taskCommand([
      "create",
      "--session",
      "s-cli-3",
      "--message",
      "x",
      "--notify",
      "slack",
    ]);
    expect(code).toBe(1);
    expect(stderr()).toMatch(/--notify only supports: telegram/);
  });

  it("create rejects missing required flags", async () => {
    const code = await taskCommand(["create", "--session", "s-only"]);
    expect(code).toBe(1);
    expect(stderr()).toMatch(/--session.*--message/);
  });

  it("create rejects non-positive --max-attempts", async () => {
    const code = await taskCommand([
      "create",
      "--session",
      "s-bad",
      "--message",
      "hi",
      "--max-attempts",
      "0",
    ]);
    expect(code).toBe(1);
    expect(stderr()).toMatch(/--max-attempts/);
  });

  it("show fails for unknown id", async () => {
    const code = await taskCommand(["show", "t-missing"]);
    expect(code).toBe(1);
    expect(stderr()).toMatch(/task not found/);
  });

  it("cancel fails for unknown id", async () => {
    const code = await taskCommand(["cancel", "t-missing"]);
    expect(code).toBe(1);
    expect(stderr()).toMatch(/task not found/);
  });

  it("list reports an empty placeholder when no tasks exist", async () => {
    const code = await taskCommand(["list"]);
    expect(code).toBe(0);
    expect(stdout()).toContain("(no tasks)");
  });

  it("list filters by --session and --status", async () => {
    const store = new TaskStore({ dbFile: getConfig().paths.tasksDbFile });
    try {
      store.create({
        sessionId: "s-a",
        userMessage: "alpha",
        origin: "cli",
        maxAttempts: 3,
      });
      const beta = store.create({
        sessionId: "s-b",
        userMessage: "beta",
        origin: "cli",
        maxAttempts: 3,
      });
      store.cancel(beta.id);
    } finally {
      store.close();
    }

    const code = await taskCommand([
      "list",
      "--session",
      "s-b",
      "--status",
      "cancelled",
    ]);
    expect(code).toBe(0);
    expect(stdout()).toContain("beta");
    expect(stdout()).not.toContain("alpha");
  });

  it("list rejects unknown --status values", async () => {
    const code = await taskCommand(["list", "--status", "weird"]);
    expect(code).toBe(1);
    expect(stderr()).toMatch(/unknown task status/);
  });
});
