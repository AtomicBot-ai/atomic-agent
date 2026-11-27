import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../../config/index.js";
import type { AgentProfile, AgentProfileSet } from "../../agent-profiles/index.js";
import type { TaskRecord } from "../../tasks/index.js";
import { createBoardAssigneeResolver } from "./runtime-board-assignee.js";

function setOf(profiles: AgentProfile[]): AgentProfileSet {
  return {
    profiles,
    get: (name) => profiles.find((p) => p.name === name),
    diagnostics: [],
    withheld: [],
  };
}

const profile = (over: Partial<AgentProfile>): AgentProfile => ({
  name: "writer",
  description: "writes",
  prompt: "Write in short sentences.",
  source: "user",
  ...over,
});

/** ATO-2498: a board card's assignee resolved to a profile run. */
describe("createBoardAssigneeResolver", () => {
  let stateDir: string;
  const context = { task: {} as TaskRecord, workingDir: "/work" };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-board-assignee-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("reads the profiles for the task's folder and answers null for a missing one", () => {
    const dirs: string[] = [];
    const resolve = createBoardAssigneeResolver((dir) => {
      dirs.push(dir);
      return setOf([profile({})]);
    });
    expect(resolve("nobody", context)).toBeNull();
    expect(dirs).toEqual(["/work"]);
  });

  it("gives the profile's instructions and keeps every tool when it lists none", () => {
    const run = createBoardAssigneeResolver(() => setOf([profile({})]))("writer", context);
    expect(run).toMatchObject({ profile: "writer", instructions: "Write in short sentences.", notes: [] });
    expect(run?.toolFilter).toBeUndefined();
    expect(run?.providerId).toBeUndefined();
  });

  it("narrows the tools to the profile's list, the board card tools kept", () => {
    const run = createBoardAssigneeResolver(() => setOf([profile({ tools: ["Read", "Frobnicate"] })]))("writer", context);
    const allows = run!.toolFilter!;
    expect(allows("os.fs.read")).toBe(true);
    expect(allows("os.shell.run")).toBe(false);
    expect(allows("tasks.block")).toBe(true);
    expect(allows("tasks.request_review")).toBe(true);
    expect(run?.notes.join(" ")).toContain("Frobnicate");
  });

  it("keeps the usual model, with a note, for a model not set up here", () => {
    const run = createBoardAssigneeResolver(() => setOf([profile({ model: "sonnet" })]))("writer", context);
    expect(run?.providerId).toBeUndefined();
    expect(run?.notes.join(" ")).toContain('"sonnet" is not set up here');
    const inherit = createBoardAssigneeResolver(() => setOf([profile({ model: "inherit" })]))("writer", context);
    expect(inherit?.notes).toEqual([]);
  });
});
