import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSummary, SKILL_EVAL_RESULT_SCHEMA, type SkillEvalResult } from "./eval-result.js";
import {
  listSkillEvalResults,
  makeRunId,
  readLatestSkillEvalResult,
  readSkillEvalResult,
  saveSkillEvalResult,
  skillEvalDir,
} from "./run-store.js";

function result(runId: string, skill = "pdf"): SkillEvalResult {
  return {
    schema: SKILL_EVAL_RESULT_SCHEMA,
    runId,
    complete: true,
    skill: { name: skill, version: "1.0.0", source: "global" },
    tasks: { file: "/x/tasks.yaml", sha256: "0".repeat(64), count: 0 },
    startedAt: "2026-11-12T09:30:00.000Z",
    finishedAt: "2026-11-12T09:31:00.000Z",
    agentVersion: "0.0.0-test",
    model: { provider: null, model: null },
    judge: null,
    options: { repeat: 1, variants: ["with", "without"], maxSteps: null, approvalLevel: 2 },
    runs: [],
    summary: buildSummary([], []),
  };
}

describe("skill eval run store", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "skill-eval-store-"));
  });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  it("makes sortable, filesystem-safe run ids", () => {
    expect(makeRunId(new Date("2026-11-12T09:30:00.123Z"))).toBe("2026-11-12T09-30-00-123Z");
  });

  it("saves under <stateDir>/skill-evals/<skill>/ and reads back the newest", async () => {
    const first = await saveSkillEvalResult(stateDir, result("2026-11-12T09-30-00-000Z"));
    await saveSkillEvalResult(stateDir, result("2026-11-12T10-00-00-000Z"));
    expect(first).toBe(join(stateDir, "skill-evals", "pdf", "2026-11-12T09-30-00-000Z.json"));
    expect(readdirSync(join(stateDir, "skill-evals", "pdf"))).not.toContain("2026-11-12T09-30-00-000Z.json.tmp");
    const files = await listSkillEvalResults(stateDir, "pdf");
    expect(files.map((f) => f.split(/[\\/]/).pop())).toEqual([
      "2026-11-12T09-30-00-000Z.json",
      "2026-11-12T10-00-00-000Z.json",
    ]);
    expect((await readLatestSkillEvalResult(stateDir, "pdf"))!.runId).toBe("2026-11-12T10-00-00-000Z");
  });

  it("keeps a plugin skill name filesystem-safe", () => {
    expect(skillEvalDir(stateDir, "acme:review")).toBe(join(stateDir, "skill-evals", "acme_review"));
  });

  it("returns nothing for a skill never evaluated", async () => {
    expect(await listSkillEvalResults(stateDir, "nope")).toEqual([]);
    expect(await readLatestSkillEvalResult(stateDir, "nope")).toBeNull();
  });

  it("refuses a file that is not a skill eval result", async () => {
    const path = join(stateDir, "other.json");
    writeFileSync(path, JSON.stringify({ schema: "something-else" }));
    await expect(readSkillEvalResult(path)).rejects.toThrow(/not a skill eval result/);
  });
});
