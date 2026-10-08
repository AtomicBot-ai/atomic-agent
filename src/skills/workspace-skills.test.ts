import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getConfig, resetConfigCache } from "../config/index.js";
import { setProjectSkillsEnabled, setSkillDisabled } from "../config/skill-policy-commands.js";
import { readUserConfigFileSync } from "../config/config-file.js";
import { createEmptySessionState } from "../session/session-state.js";
import { reconcileCloudSkills } from "../session/workspace-context.js";
import { createWorkspaceLoader } from "../runtime/session-workspace.js";
import { ApprovalGate } from "../approval/approval-gate.js";
import { buildSkillRunScriptTool } from "../tools/skill/skill-run-script.js";
import { buildSkillViewTool } from "../tools/skill/skill-view.js";
import { SkillRegistry } from "./skill-registry.js";
import { loadWorkspaceSkills } from "./workspace-skills.js";

describe("session workspace skills and live policy", () => {
  let base: string; let a: string; let b: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "workspace-skills-")));
    a = join(base, "a"); b = join(base, "b"); mkdirSync(a); mkdirSync(b);
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", join(base, "state")); resetConfigCache();
  });
  afterEach(() => { vi.unstubAllEnvs(); resetConfigCache(); rmSync(base, { recursive: true, force: true }); });
  function put(dir: string, name = "example", body = dir, extra = "") {
    const path = join(dir, name, "SKILL.md"); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nname: ${name}\ndescription: Example skill\n${extra}\n---\n${body}`); return path;
  }
  function load(dir = a, compatible = true) {
    const c = getConfig(); return loadWorkspaceSkills(dir, { globalDir: c.paths.globalSkillsDir, projectDirName: c.paths.projectSkillsDirName, configFile: c.paths.userConfigFile, defaults: c.skills }, compatible);
  }

  it("deduplicates all copies by name in source priority, with root-only discovery", () => {
    const dirs = [".atomic-agent/skills", ".agents/skills", ".claude/skills", ".cursor/skills", ".pi/skills"].map(p => join(a, p));
    dirs.push(getConfig().paths.globalSkillsDir);
    const paths = dirs.map(d => put(d)); put(join(a, "nested/.agents/skills"), "nested");
    const found = load(); expect(found.entries).toHaveLength(1);
    expect(found.entries[0]?.record.manifestPath).toBe(paths[0]);
    expect(found.entries[0]?.sources).toEqual(paths);
    expect(found.diagnostics.join()).toContain("shadowed");
    rmSync(paths[0]!); expect(load().entries[0]?.record.manifestPath).toBe(paths[1]);
  });

  it("accepts Claude folder names, optional versions and excludes manual-only invocation", () => {
    const path = put(join(a, ".claude/skills"), "x", "manual", "disable-model-invocation: true");
    writeFileSync(path, "---\ndescription: Manual only\ndisable-model-invocation: true\n---\nmanual");
    const item = load().entries[0]!; expect(item.record.manifest.name).toBe("x");
    expect(item.disabledReasons).toContain("disable-model-invocation");
    expect(load(a, false).entries).toEqual([]);
  });

  it("isolates workspace denies and bulk switches while global denies win everywhere", () => {
    put(join(a, ".agents/skills")); put(join(b, ".agents/skills")); put(getConfig().paths.globalSkillsDir);
    const stale = load(); setSkillDisabled("example", true, a);
    expect(() => stale.assertAvailable("example")).toThrow(/disabled in workspace/);
    expect(load(b).entries[0]?.disabledReasons).toEqual([]);
    setProjectSkillsEnabled(a, false);
    expect(load().entries[0]?.record.source).toBe("global");
    expect(load().entries[0]?.disabledReasons).toContain("disabled in workspace");
    setSkillDisabled("example", false, a); expect(load().entries[0]?.disabledReasons).toEqual([]);
    setSkillDisabled("example", true); setProjectSkillsEnabled(a, true);
    expect(load().entries[0]?.disabledReasons).toContain("disabled globally");
    expect(load(b).entries[0]?.disabledReasons).toContain("disabled globally");
    expect(load(b, false).entries[0]?.disabledReasons).toContain("disabled globally");
  });

  it("stores canonical workspace policy without modifying the project", () => {
    const alias = join(base, "alias"); symlinkSync(a, alias);
    setSkillDisabled("x", true, alias);
    expect(readUserConfigFileSync(getConfig().paths.userConfigFile)?.skills.cloudWorkspaces).toEqual([{ workingDir: a, projectSkillsEnabled: true, disabled: ["x"] }]);
    expect(existsSync(join(a, ".atomic-agent"))).toBe(false);
  });

  it("rereads changed bodies, deactivates switched/deleted sources and never mutates local loads", () => {
    const path = put(join(a, ".agents/skills"), "example", "old"); put(getConfig().paths.globalSkillsDir, "example", "global");
    const loader = createWorkspaceLoader(getConfig());
    let session = createEmptySessionState({ id: "a", workingDir: a });
    session.loadedSkills = [{ name: "example", version: "1", body: "legacy", loadedAt: 1 }];
    session = reconcileCloudSkills(session, loader(session, true));
    expect(session.cloudLoadedSkills?.[0]?.body).toContain("old");
    const stale = load(); put(join(a, ".agents/skills"), "example", "new");
    expect(() => stale.assertAvailable("example")).toThrow(/changed/);
    session = reconcileCloudSkills(JSON.parse(JSON.stringify(session)), loader(session, true));
    expect(session.cloudLoadedSkills?.[0]?.body).toContain("new");
    expect(session.loadedSkills[0]?.body).toBe("legacy");
    rmSync(path); session = reconcileCloudSkills(session, loader(session, true));
    expect(session.cloudLoadedSkills).toEqual([]);
    put(join(a, ".agents/skills")); expect(reconcileCloudSkills(session, loader(session, true)).cloudLoadedSkills).toEqual([]);
  });

  it("binds view, references and scripts to the winner and rechecks after approval", async () => {
    const path = put(join(a, ".agents/skills"), "example", "Read references/data.md", "requires_scripts: [run.js]");
    put(getConfig().paths.globalSkillsDir, "example", "wrong global");
    mkdirSync(join(dirname(path), "scripts"));
    writeFileSync(join(dirname(path), "scripts/run.js"), "process.stdout.write('PROJECT SCRIPT')");
    const registry = new SkillRegistry({ globalDir: getConfig().paths.globalSkillsDir, projectDir: null }); await registry.refresh();
    const ctx = { sessionId: "a", stepIndex: 0, workingDir: a, modelMode: "cloud" as const, workspaceSkills: load(), signal: new AbortController().signal };
    const view = await buildSkillViewTool(registry).run({ name: "example" }, ctx);
    expect(view.summary).toContain(dirname(path)); expect(view.summary).not.toContain("wrong global");
    let disableOnApproval = false;
    const gate = new ApprovalGate({ emit(req) {
      if (disableOnApproval) setSkillDisabled("example", true, a);
      gate.resolve({ approvalId: req.approvalId, approved: true });
    } });
    const tool = buildSkillRunScriptTool(registry, { approvals: gate, approvalRequired: true });
    const result = await tool.run({ skill: "example", script: "run.js" }, ctx); expect(result.summary).toContain("PROJECT SCRIPT");
    disableOnApproval = true;
    await expect(tool.run({ skill: "example", script: "run.js" }, ctx)).rejects.toThrow(/disabled in workspace/);
    await expect(buildSkillViewTool(registry).run({ name: "example" }, ctx)).rejects.toThrow(/disabled in workspace/);
    setSkillDisabled("example", false, a); expect(load().assertAvailable("example").body).toContain("references/data.md");
  });

  it("never imports project symlinks outside the workspace", () => {
    const outside = join(base, "outside"); put(outside);
    mkdirSync(join(a, ".agents")); symlinkSync(outside, join(a, ".agents/skills"));
    expect(load().entries).toEqual([]); expect(load().diagnostics.join()).toContain("outside workspace");
  });

  it("keeps a shared Atomic/global directory global even through a path alias", () => {
    const c = getConfig(); put(c.paths.globalSkillsDir);
    const alias = join(base, "state-alias"); symlinkSync(c.paths.stateDir, alias);
    setProjectSkillsEnabled(c.paths.stateDir, false);
    const found = loadWorkspaceSkills(c.paths.stateDir, { globalDir: join(alias, "skills"), projectDirName: "skills", configFile: c.paths.userConfigFile, defaults: c.skills });
    expect(found.entries[0]?.record.source).toBe("global"); expect(found.entries[0]?.disabledReasons).toEqual([]);
  });

  it("does not give a project copy of gog-workspace the built-in approval exception", async () => {
    const path = put(join(a, ".agents/skills"), "gog-workspace", "project code", "requires_scripts: [check-gog.sh]\nallowed-tools: Bash");
    mkdirSync(join(dirname(path), "scripts")); writeFileSync(join(dirname(path), "scripts/check-gog.sh"), "echo should-not-run");
    let approvals = 0;
    const gate = new ApprovalGate({ emit(req) { approvals++; gate.resolve({ approvalId: req.approvalId, approved: false }); } });
    const registry = new SkillRegistry({ globalDir: getConfig().paths.globalSkillsDir, projectDir: null });
    const tool = buildSkillRunScriptTool(registry, { approvals: gate, approvalRequired: true });
    await expect(tool.run({ skill: "gog-workspace", script: "check-gog.sh" }, { sessionId: "a", stepIndex: 0, workingDir: a, modelMode: "cloud", workspaceSkills: load(), signal: new AbortController().signal })).rejects.toThrow();
    expect(approvals).toBe(1);
  });
});
