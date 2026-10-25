import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestHarness, type Harness } from "./test-harness.js";

interface Status {
  workingDir: string;
  question: string | null;
  questionId: string | null;
  pending: { skills: string[]; instructions: string[] };
  trusted: { skills: string[]; instructions: string[] };
}

describe("/api/project-trust", () => {
  let harness: Harness;
  beforeEach(async () => { harness = await startTestHarness(); });
  afterEach(async () => { await harness.cleanup(); });

  function projectSkill(name: string): void {
    const dir = join(harness.workingDir, ".atomic-agent", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: "${name}"\nversion: 0.1.0\n---\nBody`);
  }
  const status = async (query = "") => (await (await fetch(`${harness.baseUrl}/api/project-trust${query}`)).json()) as Status;
  const answer = (body: Record<string, unknown>) => fetch(`${harness.baseUrl}/api/project-trust`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("reports the pending question and keeps the skill out of the catalog until it is answered", async () => {
    projectSkill("repo-skill"); writeFileSync(join(harness.workingDir, "AGENTS.md"), "RULE");
    await harness.runtime.refreshSkills();
    expect(harness.runtime.skillRegistry.list().some(s => s.manifest.name === "repo-skill")).toBe(false);
    const first = await status();
    expect(first.question).toBe("This folder has 1 project skill and AGENTS.md. Trust them?");
    expect(first.pending).toEqual({ skills: ["repo-skill"], instructions: ["AGENTS.md"] });

    const accepted = await answer({ answer: "trust", questionId: first.questionId });
    expect(accepted.status).toBe(200);
    const after = (await accepted.json()) as Status;
    expect(after.question).toBeNull(); expect(after.trusted.skills).toEqual(["repo-skill"]);
    // The route refreshes the local catalog itself.
    expect(harness.runtime.skillRegistry.list().some(s => s.manifest.name === "repo-skill")).toBe(true);
  });

  it("refuses a stale question with 409 and the fresh status, recording nothing", async () => {
    projectSkill("one");
    const shown = await status();
    projectSkill("two");
    const response = await answer({ answer: "trust", questionId: shown.questionId });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string }; status: Status };
    expect(body.error.code).toBe("question_changed");
    expect(body.status.pending.skills).toEqual(["one", "two"]);
    expect((await status()).trusted.skills).toEqual([]);
  });

  it("remembers a decline and validates input", async () => {
    projectSkill("one");
    const shown = await status(`?workingDir=${encodeURIComponent(harness.workingDir)}`);
    expect((await answer({ answer: "maybe", questionId: shown.questionId })).status).toBe(400);
    expect((await answer({ answer: "trust" })).status).toBe(400);
    expect((await answer({ answer: "trust", questionId: shown.questionId, workingDir: "relative/path" })).status).toBe(400);
    expect((await answer({ answer: "trust", questionId: shown.questionId, sessionId: "missing" })).status).toBe(404);
    expect((await answer({ answer: "decline", questionId: shown.questionId, workingDir: harness.workingDir })).status).toBe(200);
    expect((await status()).question).toBeNull();
    expect(harness.runtime.skillRegistry.list().some(s => s.manifest.name === "one")).toBe(false);
  });
});
