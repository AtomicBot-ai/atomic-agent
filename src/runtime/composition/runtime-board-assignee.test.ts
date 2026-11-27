import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as configuration from "../../config/index.js";
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
    vi.restoreAllMocks();
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

  it("pins the run to a configured provider or to the provider a fusion role is set to", () => {
    vi.spyOn(configuration, "getConfig").mockReturnValue({
      llm: { providers: [{ id: "p1" }], runMode: { fusion: { roles: { build: "p1" } } } },
    } as unknown as ReturnType<typeof configuration.getConfig>);
    for (const model of ["p1", "build"]) {
      const run = createBoardAssigneeResolver(() => setOf([profile({ model })]))("writer", context);
      expect(run?.providerId, model).toBe("p1");
      expect(run?.notes, model).toEqual([]);
    }
    // A role that is not set up keeps the usual model.
    const review = createBoardAssigneeResolver(() => setOf([profile({ model: "review" })]))("writer", context);
    expect(review?.providerId).toBeUndefined();
  });
});
