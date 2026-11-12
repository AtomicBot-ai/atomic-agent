import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getConfig, resetConfigCache } from "../config/index.js";
import { IdeaStore, TaskStore } from "../tasks/index.js";

import { ideasCommand } from "./ideas-command.js";

describe("ideasCommand", () => {
  let stateDir: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-ideas-cli-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  function failedTask(message: string): string {
    const store = new TaskStore({ dbFile: getConfig().paths.tasksDbFile });
    try {
      const t = store.create({ userMessage: message, origin: "cli", maxAttempts: 1 });
      store.markRunning(t.id);
      store.markFailed(t.id, { category: "model", message: "empty reply" });
      return t.id;
    } finally {
      store.close();
    }
  }

  function onlyNewIdeaId(): string {
    const ideas = new IdeaStore({ dbFile: getConfig().paths.tasksDbFile });
    try {
      const list = ideas.list({ status: "new" });
      expect(list).toHaveLength(1);
      return list[0]!.id;
    } finally {
      ideas.close();
    }
  }

  it("prints help without a subcommand", async () => {
    expect(await ideasCommand([])).toBe(0);
    expect(out.join("")).toMatch(/atomic-agent ideas/);
  });

  it("refresh lists a failed task as an idea with its evidence", async () => {
    failedTask("summarise the notes");
    expect(await ideasCommand(["refresh"])).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/1 new, 0 retired, 1 waiting/);
    expect(text).toMatch(/Retry: summarise the notes/);
    expect(text).toMatch(/evidence \(task .+\): empty reply/);
  });

  it("accept --prompt files a pending task; a second accept fails", async () => {
    failedTask("summarise the notes");
    await ideasCommand(["refresh"]);
    const id = onlyNewIdeaId();
    expect(await ideasCommand(["accept", id, "--prompt", "summarise only today's notes"])).toBe(0);
    const printed = JSON.parse(out.slice(-1)[0]!) as {
      idea: { status: string; taskId: string };
      task: { id: string; userMessage: string; status: string };
    };
    expect(printed.idea).toMatchObject({ status: "accepted", taskId: printed.task.id });
    expect(printed.task).toMatchObject({ userMessage: "summarise only today's notes", status: "pending" });
    expect(await ideasCommand(["accept", id])).toBe(1);
    expect(err.join("")).toMatch(/already accepted/);
  });

  it("dismiss keeps the idea from coming back", async () => {
    failedTask("summarise the notes");
    await ideasCommand(["refresh"]);
    const id = onlyNewIdeaId();
    expect(await ideasCommand(["dismiss", id])).toBe(0);
    out = [];
    expect(await ideasCommand(["refresh"])).toBe(0);
    expect(out.join("")).toMatch(/0 new, 0 retired, 0 waiting/);
  });

  it("rejects an unknown status", async () => {
    expect(await ideasCommand(["list", "--status", "done"])).toBe(1);
    expect(err.join("")).toMatch(/unknown idea status/);
  });
});
