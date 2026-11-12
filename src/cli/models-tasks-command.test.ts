import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfig, resetConfigCache } from "../config/index.js";
import { parseFitTaskSet } from "../fit-test/index.js";
import {
  assistantReplyTurn,
  assistantToolCallTurn,
  createEmptySessionState,
  SessionStore,
  toolResultTurn,
  userTurn,
} from "../session/index.js";
import { parseLastFlag, runModelsTasks } from "./models-tasks-command.js";

describe("parseLastFlag", () => {
  it("defaults to 10 and takes a whole number", () => {
    expect(parseLastFlag([])).toBe(10);
    expect(parseLastFlag(["--last", "3"])).toBe(3);
    expect(parseLastFlag(["--last", "0"])).toBe("invalid");
    expect(parseLastFlag(["--last", "x"])).toBe("invalid");
  });
});

describe("models tasks collect", () => {
  let stateDir: string;
  let out: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-models-tasks-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    out = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it("writes the stored chats' tasks to --out, without the outbound one", async () => {
    const t = Date.parse("2026-11-01T10:00:00Z");
    const store = new SessionStore({ dbFile: getConfig().paths.sessionsDbFile });
    try {
      store.save({
        ...createEmptySessionState({ id: "s-1", workingDir: stateDir }),
        turns: [
          userTurn("count the lines in notes.md", t),
          assistantToolCallTurn({ tool: "os.fs.read", args: { path: "notes.md" }, at: t + 1 }),
          toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "3 lines", at: t + 2 }),
          assistantReplyTurn("3 lines", t + 3),
          userTurn("open a PR for it", t + 4),
          assistantToolCallTurn({ tool: "github.pr.create", args: {}, at: t + 5 }),
          toolResultTurn({ tool: "github.pr.create", status: "ok", summary: "#1", at: t + 6 }),
          assistantReplyTurn("opened #1", t + 7),
        ],
      });
    } finally {
      store.close();
    }
    const file = join(stateDir, "tasks.json");
    expect(await runModelsTasks(["collect", "--last", "5", "--out", file])).toBe(0);
    const set = parseFitTaskSet(JSON.parse(readFileSync(file, "utf8")));
    expect(set.tasks.map((task) => task.prompt)).toEqual(["count the lines in notes.md"]);
    expect(out.join("")).toContain("1 outbound");
  });

  it("refuses a bad --last and an unknown action", async () => {
    expect(await runModelsTasks(["collect", "--last", "-1"])).toBe(2);
    expect(await runModelsTasks(["wipe"])).toBe(2);
  });
});
