import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getConfig, resetConfigCache } from "../config/index.js";
import { readUserConfigFileSync } from "../config/config-file.js";
import { createEmptySessionState } from "../session/session-state.js";
import * as seeding from "../skills/seed-starter-skills.js";
import { StructuredLogger, type LogRecord } from "../tracing/structured-logger.js";
import { prepareRuntimeSkills } from "./composition/runtime-skills.js";
import { createWorkspaceLoader } from "./session-workspace.js";
import {
  answerProjectTrust,
  describeProjectTrustQuestion,
  inspectProjectTrust,
  ProjectTrustConflictError,
  setProjectTrust,
} from "./project-trust.js";

describe("project folder trust (ATO-298 soft trust)", () => {
  let base: string; let repo: string; let logs: LogRecord[]; let logger: StructuredLogger;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "project-trust-")));
    repo = join(base, "repo"); mkdirSync(repo);
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", join(base, "state")); resetConfigCache();
    vi.spyOn(seeding, "seedStarterSkillsIfMissing").mockResolvedValue({ sourceDir: null, installed: [], removed: [] });
    logs = []; logger = new StructuredLogger({ level: "warn", sinks: [record => logs.push(record)] });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetConfigCache(); rmSync(base, { recursive: true, force: true }); });

  function skill(dir: string, name: string, body = `${name.toUpperCase()} BODY`): string {
    const path = join(repo, dir, name, "SKILL.md"); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nname: ${name}\ndescription: ${name} guide\nversion: 1.0.0\n---\n${body}`); return path;
  }
  /** Cloud view: catalog entries the model may use and the instruction blocks it receives. */
  function cloud(loader = createWorkspaceLoader(getConfig(), logger)) {
    const workspace = loader(createEmptySessionState({ id: "s", workingDir: repo }), true);
    return { skills: workspace.skills.entries.filter(e => !e.disabledReasons.length).map(e => e.record.manifest.name),
      reasons: Object.fromEntries(workspace.skills.entries.map(e => [e.record.manifest.name, e.disabledReasons])),
      instructions: workspace.instructions.map(i => i.body) };
  }
  async function local() {
    const prepared = await prepareRuntimeSkills(getConfig(), repo, logger);
    return { registry: prepared.skillRegistry, catalog: prepared.createCatalog().getSkillCatalog().map(e => e.name) };
  }

  it("loads nothing a fresh folder ships, asks once with counts, and loads it after yes", async () => {
    skill(".atomic-agent/skills", "alpha"); skill(".agents/skills", "beta"); skill(".claude/skills", "gamma");
    writeFileSync(join(repo, "AGENTS.md"), "AGENTS RULE");
    const before = cloud();
    expect(before.skills).toEqual([]); expect(before.instructions).toEqual([]);
    expect(before.reasons.alpha).toContain("not trusted in this folder yet");
    const first = await local();
    expect(first.registry.list().map(s => s.manifest.name)).toEqual([]);
    expect(first.catalog).toEqual([]);
    expect(first.registry.listAll().map(e => [e.record.manifest.name, e.trust])).toEqual([["alpha", "pending"]]);

    const status = inspectProjectTrust(getConfig(), repo);
    expect(status.question).toBe("This folder has 3 project skills and AGENTS.md. Trust them?");
    expect(status.pending).toEqual({ skills: ["alpha", "beta", "gamma"], instructions: ["AGENTS.md"] });
    expect(status.questionId).toMatch(/^[0-9a-f]{16}$/);

    const after = answerProjectTrust(getConfig(), repo, "trust", status.questionId!);
    expect(after.question).toBeNull(); expect(after.trusted.skills).toEqual(["alpha", "beta", "gamma"]);
    expect(cloud().skills).toEqual(["alpha", "beta", "gamma"]); expect(cloud().instructions).toEqual(["AGENTS RULE"]);
    await first.registry.refresh();
    expect(first.registry.list().map(s => s.manifest.name)).toEqual(["alpha"]);
    // The answer lives in user config, never in the repository.
    expect(existsSync(join(repo, ".atomic-agent", "config.json"))).toBe(false);
    expect(readUserConfigFileSync(getConfig().paths.userConfigFile)?.skills.projectTrust[0]?.workingDir).toBe(realpathSync.native(repo));
  });

  it("keeps a skill that appears after trust unloaded until asked again; edits of trusted ones do not ask", async () => {
    const alpha = skill(".atomic-agent/skills", "alpha"); writeFileSync(join(repo, "AGENTS.md"), "RULE ONE");
    answerProjectTrust(getConfig(), repo, "trust", inspectProjectTrust(getConfig(), repo).questionId!);
    writeFileSync(alpha, "---\nname: alpha\ndescription: edited\nversion: 1.0.1\n---\nEDITED BODY");
    writeFileSync(join(repo, "AGENTS.md"), "RULE TWO");
    expect(inspectProjectTrust(getConfig(), repo).question).toBeNull();
    expect(cloud().skills).toEqual(["alpha"]); expect(cloud().instructions).toEqual(["RULE TWO"]);

    skill(".atomic-agent/skills", "intruder"); writeFileSync(join(repo, "CLAUDE.md"), "NEW CLAUDE RULE");
    const view = cloud();
    expect(view.skills).toEqual(["alpha"]); expect(view.instructions).toEqual(["RULE TWO"]);
    const { registry } = await local();
    expect(registry.list().map(s => s.manifest.name)).toEqual(["alpha"]);
    const status = inspectProjectTrust(getConfig(), repo);
    expect(status.pending).toEqual({ skills: ["intruder"], instructions: ["CLAUDE.md"] });
    expect(status.question).toBe("This folder has 1 new project skill and new CLAUDE.md. Trust them?");

    // "No" is remembered: the folder is not asked about again until something else is new.
    answerProjectTrust(getConfig(), repo, "decline", status.questionId!);
    expect(inspectProjectTrust(getConfig(), repo).question).toBeNull();
    expect(cloud().reasons.intruder).toContain("declined in this folder");
    expect(cloud().skills).toEqual(["alpha"]); expect(cloud().instructions).toEqual(["RULE TWO"]);
    skill(".agents/skills", "later");
    expect(inspectProjectTrust(getConfig(), repo).pending).toEqual({ skills: ["later"], instructions: [] });
  });

  it("refuses an answer to a question that no longer matches the folder", () => {
    skill(".agents/skills", "alpha");
    const shown = inspectProjectTrust(getConfig(), repo);
    skill(".agents/skills", "sneaky");
    expect(() => answerProjectTrust(getConfig(), repo, "trust", shown.questionId!)).toThrow(ProjectTrustConflictError);
    expect(readUserConfigFileSync(getConfig().paths.userConfigFile)?.skills.projectTrust ?? []).toEqual([]);
    expect(cloud().skills).toEqual([]);
  });

  it("loads nothing without an answer and leaves only an operator hint (headless run, serve, channels)", async () => {
    skill(".atomic-agent/skills", "alpha"); writeFileSync(join(repo, "AGENTS.md"), "RULE");
    const { catalog } = await local();
    expect(catalog).toEqual([]);
    const loader = createWorkspaceLoader(getConfig(), logger);
    const workspace = loader(createEmptySessionState({ id: "s", workingDir: repo }), true);
    expect(workspace.instructions).toEqual([]);
    // The hint is for the operator's log; the model's context must not invite it to trust the folder.
    expect(workspace.diagnostics.join("\n")).not.toContain("skill project on");
    const hints = logs.filter(r => r.message.includes("not trusted yet"));
    expect(hints.length).toBe(2);
    expect(hints.every(r => String(r.context?.hint).startsWith("atomic-agent skill project on --workspace "))).toBe(true);
    loader(createEmptySessionState({ id: "s", workingDir: repo }), true);
    expect(logs.filter(r => r.message.includes("not trusted yet")).length).toBe(2);
  });

  it("does not let a trusted file import an untrusted instruction file", () => {
    writeFileSync(join(repo, "CLAUDE.md"), "CLAUDE RULE");
    answerProjectTrust(getConfig(), repo, "trust", inspectProjectTrust(getConfig(), repo).questionId!);
    writeFileSync(join(repo, "AGENTS.md"), "UNTRUSTED AGENTS RULE");
    writeFileSync(join(repo, "CLAUDE.md"), "CLAUDE RULE\n@AGENTS.md\n@agents.md");
    expect(cloud().instructions.join("\n")).not.toContain("UNTRUSTED AGENTS RULE");
    expect(cloud().instructions.join("\n")).toContain("CLAUDE RULE");
  });

  it("keys the answer by the real folder: a symlink alias or another letter case shares it", () => {
    skill(".agents/skills", "alpha");
    const alias = join(base, "alias"); symlinkSync(repo, alias);
    setProjectTrust(getConfig(), alias, true);
    expect(cloud().skills).toEqual(["alpha"]);
    expect(inspectProjectTrust(getConfig(), join(base, "alias", "..", "repo")).question).toBeNull();
    const upper = join(base, "REPO");
    // Only meaningful on a case-insensitive volume (the macOS and Windows default).
    if (existsSync(upper)) expect(inspectProjectTrust(getConfig(), upper).question).toBeNull();
  });

  it("revokes with project off: everything is declined and unloaded, project on trusts it again", () => {
    skill(".agents/skills", "alpha"); writeFileSync(join(repo, "AGENTS.md"), "RULE");
    setProjectTrust(getConfig(), repo, true);
    expect(cloud().skills).toEqual(["alpha"]);
    const off = setProjectTrust(getConfig(), repo, false);
    expect(off.declined).toEqual({ skills: ["alpha"], instructions: ["AGENTS.md"] });
    expect(cloud().skills).toEqual([]); expect(cloud().instructions).toEqual([]);
    expect(off.question).toBeNull();
  });

  it("never covers global skills, which stay trusted", async () => {
    const dir = join(getConfig().paths.globalSkillsDir, "global-one"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: global-one\ndescription: g\nversion: 1.0.0\n---\nG");
    expect(cloud().skills).toEqual(["global-one"]);
    expect((await local()).catalog).toEqual(["global-one"]);
    expect(inspectProjectTrust(getConfig(), repo).question).toBeNull();
  });

  it("words the question for one item and for many files", () => {
    expect(describeProjectTrustQuestion({ skills: ["a"], instructions: [] })).toBe("This folder has 1 project skill. Trust it?");
    expect(describeProjectTrustQuestion({ skills: [], instructions: ["AGENTS.md", "CLAUDE.md", "pkg/AGENTS.md"] }))
      .toBe("This folder has 3 instruction files. Trust them?");
  });
});
