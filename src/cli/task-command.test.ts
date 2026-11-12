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

  it("create --notify push persists the phone-push opt-in (ATO-1129)", async () => {
    const code = await taskCommand([
      "create",
      "--session",
      "s-cli-push",
      "--message",
      "nightly build",
      "--notify",
      "push",
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout()).notify).toBe("push");
  });

  it("create --max-cost-usd / --max-duration persist the task's budget; default stays null", async () => {
    const code = await taskCommand([
      "create",
      "--session",
      "s-cli-budget",
      "--message",
      "long job",
      "--max-cost-usd",
      "2.50",
      "--max-duration",
      "1h30m",
    ]);
    expect(code).toBe(0);
    const created = JSON.parse(stdout());
    expect(created.maxCostUsd).toBe(2.5);
    expect(created.maxDurationMs).toBe(90 * 60_000);
    expect(created.spentUsd).toBeNull();

    const store = new TaskStore({ dbFile: getConfig().paths.tasksDbFile });
    try {
      expect(store.get(created.id)).toMatchObject({
        maxCostUsd: 2.5,
        maxDurationMs: 5_400_000,
      });
    } finally {
      store.close();
    }

    stdoutChunks.length = 0;
    expect(
      await taskCommand(["create", "--session", "s-cli-budget", "--message", "plain"]),
    ).toBe(0);
    const plain = JSON.parse(stdout());
    expect(plain.maxCostUsd).toBeNull();
    expect(plain.maxDurationMs).toBeNull();
  });

  it.each([
    ["--max-cost-usd", "0", /--max-cost-usd must be a positive number/],
    ["--max-cost-usd", "five", /--max-cost-usd must be a positive number/],
    ["--max-duration", "8 hours", /--max-duration must be a duration/],
    ["--max-duration", "0s", /--max-duration must be a duration/],
  ])("create rejects %s %s", async (flag, value, message) => {
    const code = await taskCommand([
      "create",
      "--session",
      "s-cli-bad-budget",
      "--message",
      "x",
      flag,
      value,
    ]);
    expect(code).toBe(1);
    expect(stderr()).toMatch(message);
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

  it("create --at keeps a one-shot task out of the due queue until that time", async () => {
    const at = Date.now() + 60 * 60_000;
    const code = await taskCommand([
      "create",
      "--message",
      "later",
      "--at",
      String(at),
    ]);
    expect(code).toBe(0);
    const created = JSON.parse(stdout());
    expect(created.scheduledFor).toBe(at);

    const store = new TaskStore({ dbFile: getConfig().paths.tasksDbFile });
    try {
      const dueIds = (now: number) => store.listDue(now).map((t) => t.id);
      expect(dueIds(Date.now())).not.toContain(created.id);
      expect(dueIds(at)).toContain(created.id);
    } finally {
      store.close();
    }
  });

  it("create --at accepts an ISO-8601 time", async () => {
    const code = await taskCommand([
      "create",
      "--message",
      "new year",
      "--at",
      "2030-01-01T09:00:00Z",
    ]);
    expect(code).toBe(0);
    const created = JSON.parse(stdout());
    expect(created.scheduledFor).toBe(Date.parse("2030-01-01T09:00:00Z"));
    expect(created.schedule).toEqual({
      kind: "at",
      at: Date.parse("2030-01-01T09:00:00Z"),
    });
  });

  it("create rejects an unparseable --at", async () => {
    const code = await taskCommand([
      "create",
      "--message",
      "x",
      "--at",
      "tomorrow-ish",
    ]);
    expect(code).toBe(1);
    expect(stderr()).toMatch(/--at must be a Unix timestamp/);
    expect(stderr()).toContain("tomorrow-ish");
  });

  it.each(["Oct 2", "-5", "2030-02-31", "2030-01-01 09:00"])(
    "create rejects the non-strict --at %j that Date.parse would accept",
    async (raw) => {
      const code = await taskCommand(["create", "--message", "x", "--at", raw]);
      expect(code).toBe(1);
      expect(stderr()).toMatch(/strict ISO-8601/);
      expect(stdout()).toBe("");
    },
  );

  it("create --at in the future prints no past-time warning", async () => {
    const code = await taskCommand([
      "create",
      "--message",
      "future",
      "--at",
      "2030-01-01T09:00:00+02:00",
    ]);
    expect(code).toBe(0);
    expect(stderr()).not.toMatch(/in the past/);
  });

  it("create --at in the past warns on stderr with the ISO time", async () => {
    const code = await taskCommand([
      "create",
      "--message",
      "overdue",
      "--at",
      "2020-01-01T00:00:00Z",
    ]);
    expect(code).toBe(0);
    expect(stderr()).toContain(
      "warning: --at 2020-01-01T00:00:00.000Z is in the past",
    );
    expect(stderr()).toMatch(/next scheduler tick/);
    const created = JSON.parse(stdout());
    expect(created.scheduledFor).toBe(Date.parse("2020-01-01T00:00:00Z"));
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
