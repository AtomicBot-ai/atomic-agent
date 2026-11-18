import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { ConversationTurn } from "../../session/conversation-turn.js";
import { createEmptySessionState, type SessionState } from "../../session/index.js";
import { skillCuratorPaths } from "../../skills/curator/index.js";
import { learnedJournalFile, readLearnedChanges } from "../../skills/learning/index.js";
import type { SkillRecord } from "../../skills/skill-loader.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createExperienceReviewer, type ExperienceReviewerDeps } from "./runtime-experience-review.js";

function completion(content: string): CompletionResult {
  return { content, reasoningContent: "", stop: true, truncated: false, timing: { promptMs: 1, predictedMs: 1, promptTokens: 1, predictedTokens: 1 }, cacheHitTokens: 0, slotId: -1, modelId: null };
}

const NEW_SKILL = [
  "---",
  "name: sync-with-delete",
  "description: Deploy a static site to an S3 bucket so removed files go too.",
  "version: 1.0.0",
  "---",
  "",
  "1. Build with `npm run build`.",
  "2. Run `aws s3 sync dist/ s3://bucket --delete`.",
  "3. Fetch the index page and check for a 200.",
  "",
].join("\n");

describe("createExperienceReviewer", () => {
  let root: string;
  let skillsDir: string;
  let selfLearning: { enabled: boolean; minSteps: number } | undefined;
  let records: SkillRecord[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "atomic-runtime-learn-"));
    skillsDir = join(root, "skills");
    mkdirSync(skillsDir, { recursive: true });
    selfLearning = undefined;
    records = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const cfg = (): AtomicAgentConfig => ({
    paths: { globalSkillsDir: skillsDir, stateDir: root },
    skills: selfLearning === undefined ? {} : { selfLearning },
    localModels: { useServerTemplate: "auto" },
  }) as unknown as AtomicAgentConfig;

  function session(steps: number, tool = "os.shell.run"): SessionState {
    const turns: ConversationTurn[] = [{ kind: "user", text: "deploy the site", at: 1 }];
    for (let i = 0; i < steps; i++) {
      turns.push({ kind: "assistant_tool_call", tool, args: tool === "os.fs.write" ? { path: join(skillsDir, "x", "SKILL.md") } : { command: `s${i}` }, at: 1 });
      turns.push({ kind: "tool_result", tool, status: "ok", summary: `ok ${i}`, at: 1 });
    }
    turns.push({ kind: "assistant_reply", text: "Deployed.", at: 2 });
    return { ...createEmptySessionState({ id: "s-1", workingDir: root }), turns };
  }

  function rig(answer = JSON.stringify({ action: "create", name: "sync-with-delete", reason: "stale files stayed", skill_md: NEW_SKILL }), overrides: Partial<ExperienceReviewerDeps> = {}) {
    const llmComplete = vi.fn(async () => completion(answer));
    const refreshSkills = vi.fn(async () => {});
    const deps: ExperienceReviewerDeps = {
      getConfig: cfg,
      llmComplete,
      slotManager: { sideCallSlotId: () => 3 },
      resolveTransport: () => "grammar",
      skillRegistry: { listAll: () => records.map((record) => ({ record, disabled: false })) },
      refreshSkills,
      pending: new Set(),
      isShutdown: () => false,
      logger: new StructuredLogger({ level: "debug", sinks: [] }),
      starterNames: async () => new Set(["pdf"]),
      ...overrides,
    };
    return { deps, llmComplete, refreshSkills, reviewer: createExperienceReviewer(deps) };
  }

  const reply = (stepCount: number) => ({ reason: "reply" as const, stepCount });
  const journal = () => readLearnedChanges(learnedJournalFile(skillCuratorPaths(root)));

  it("reviews a turn of at least 10 steps by default and saves the skill it learned", async () => {
    const { reviewer, llmComplete, refreshSkills } = rig();
    expect(reviewer.maybeReview(session(10), { result: reply(10), origin: "tui" })).toBe(true);
    await reviewer.whenIdle();
    expect(llmComplete).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(skillsDir, "sync-with-delete", "SKILL.md"), "utf8")).toBe(NEW_SKILL);
    expect((await journal()).map((e) => [e.name, e.action])).toEqual([["sync-with-delete", "create"]]);
    expect(refreshSkills).toHaveBeenCalledTimes(1);
  });

  it("does not call the model for a short turn", async () => {
    const { reviewer, llmComplete } = rig();
    expect(reviewer.maybeReview(session(9), { result: reply(9), origin: "tui" })).toBe(false);
    await reviewer.whenIdle();
    expect(llmComplete).not.toHaveBeenCalled();
  });

  it("follows skills.selfLearning: off, or a higher step count", async () => {
    selfLearning = { enabled: false, minSteps: 10 };
    const off = rig();
    expect(off.reviewer.maybeReview(session(30), { result: reply(30), origin: "tui" })).toBe(false);
    selfLearning = { enabled: true, minSteps: 20 };
    const higher = rig();
    expect(higher.reviewer.maybeReview(session(15), { result: reply(15), origin: "tui" })).toBe(false);
    expect(higher.reviewer.maybeReview(session(20), { result: reply(20), origin: "tui" })).toBe(true);
    await higher.reviewer.whenIdle();
    expect(off.llmComplete).not.toHaveBeenCalled();
    expect(higher.llmComplete).toHaveBeenCalledTimes(1);
  });

  it("skips scheduled and fusion turns, skill evals, incognito chats, ceilings and failures", async () => {
    const { reviewer, llmComplete } = rig();
    expect(reviewer.maybeReview(session(12), { result: reply(12), origin: "scheduler" })).toBe(false);
    expect(reviewer.maybeReview(session(12), { result: reply(12), origin: "fusion" })).toBe(false);
    expect(reviewer.maybeReview(session(12), { result: reply(12), origin: "cli", memoryReadOnly: true })).toBe(false);
    expect(reviewer.maybeReview({ ...session(12), incognito: { at: 1 } } as unknown as SessionState, { result: reply(12), origin: "tui" })).toBe(false);
    expect(reviewer.maybeReview(session(12), { result: { reason: "reply", stepCount: 12, stopCause: "step_ceiling" }, origin: "tui" })).toBe(false);
    expect(reviewer.maybeReview(session(12), { result: { reason: "failed", stepCount: 12 }, origin: "tui" })).toBe(false);
    expect(llmComplete).not.toHaveBeenCalled();
  });

  it("skips a turn that wrote into the skills folder itself", async () => {
    const { reviewer, llmComplete } = rig();
    expect(reviewer.maybeReview(session(12, "os.fs.write"), { result: reply(12), origin: "tui" })).toBe(false);
    expect(llmComplete).not.toHaveBeenCalled();
  });

  it("runs one review at a time", async () => {
    const { reviewer, llmComplete } = rig('{"action":"none","reason":"routine"}');
    expect(reviewer.maybeReview(session(12), { result: reply(12), origin: "tui" })).toBe(true);
    expect(reviewer.maybeReview(session(12), { result: reply(12), origin: "tui" })).toBe(false);
    await reviewer.whenIdle();
    expect(llmComplete).toHaveBeenCalledTimes(1);
    expect(await journal()).toEqual([]);
  });

  it("never patches a starter skill, even one the turn used", async () => {
    const pdfDir = join(skillsDir, "pdf");
    mkdirSync(pdfDir);
    const starter = "---\nname: pdf\ndescription: Read PDFs.\nversion: 1.0.0\n---\n\nStarter body that must not change at all.\n";
    writeFileSync(join(pdfDir, "SKILL.md"), starter);
    records = [{ manifest: { name: "pdf", description: "Read PDFs.", version: "1.0.0", requiresTools: [], requiresScripts: [], dangerous: false }, rootDir: pdfDir, manifestPath: join(pdfDir, "SKILL.md"), source: "global" }];
    const patched = starter.replace("Starter body that must not change at all.", "Rewritten by the review, which it must not do.");
    const { reviewer, llmComplete } = rig(JSON.stringify({ action: "patch", name: "pdf", reason: "r", skill_md: patched }));
    const state = session(12);
    state.turns.splice(1, 0, { kind: "assistant_tool_call", tool: "skill.view", args: { name: "pdf" }, at: 1 }, { kind: "tool_result", tool: "skill.view", status: "ok", summary: "pdf", at: 1 });
    expect(reviewer.maybeReview(state, { result: reply(13), origin: "tui" })).toBe(true);
    await reviewer.whenIdle();
    expect(llmComplete).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(pdfDir, "SKILL.md"), "utf8")).toBe(starter);
    expect(existsSync(join(skillCuratorPaths(root).historyDir, "pdf"))).toBe(false);
  });
});
