import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPluginFromDir, PluginInstallError, removePlugin, setPluginEnabled, setPluginPartEnabled } from "./plugin-install.js";
import { listEnabledPluginSkills, resetPluginCache } from "./plugin-runtime.js";
import { installedPluginDir, readPluginState } from "./plugin-store.js";
import { listPluginSubagents } from "./plugin-subagents.js";
import { writeClaudePlugin } from "./test-plugin-fixture.js";

describe("plugin install", () => {
  let base: string;
  let stateDir: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "atomic-plugin-install-"));
    stateDir = join(base, "state");
    resetPluginCache();
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("copies the plugin, records it and exposes its skills as plugin:skill dirs", () => {
    const src = writeClaudePlugin(join(base, "src"));
    const rec = installPluginFromDir(stateDir, src);
    expect(rec).toMatchObject({ name: "demo", version: "1.2.0", enabled: true, source: { kind: "local" } });
    expect(existsSync(join(installedPluginDir(stateDir, "demo"), "skills", "review", "SKILL.md"))).toBe(true);
    const skills = listEnabledPluginSkills(stateDir);
    expect(skills.map(s => [s.plugin, s.rootSkill])).toEqual([["demo", false], ["demo", false]]);
  });

  it("refuses a second install without force and replaces with force", () => {
    const src = writeClaudePlugin(join(base, "src"));
    installPluginFromDir(stateDir, src);
    expect(() => installPluginFromDir(stateDir, src)).toThrow(PluginInstallError);
    expect(installPluginFromDir(stateDir, src, { force: true }).name).toBe("demo");
  });

  it("drops symlinks while copying", () => {
    const src = writeClaudePlugin(join(base, "src"));
    symlinkSync("/etc", join(src, "skills", "review", "etc-link"));
    installPluginFromDir(stateDir, src);
    expect(existsSync(join(installedPluginDir(stateDir, "demo"), "skills", "review", "etc-link"))).toBe(false);
  });

  it("disabling the plugin or one skill hides it; remove deletes files", () => {
    installPluginFromDir(stateDir, writeClaudePlugin(join(base, "src")));
    setPluginPartEnabled(stateDir, "demo", "skill:tidy", false);
    resetPluginCache();
    expect(listEnabledPluginSkills(stateDir).map(s => s.dir.split("/").pop())).toEqual(["review"]);
    setPluginEnabled(stateDir, "demo", false);
    resetPluginCache();
    expect(listEnabledPluginSkills(stateDir)).toEqual([]);
    expect(removePlugin(stateDir, "demo")).toBe(true);
    expect(readPluginState(stateDir).plugins).toEqual({});
    expect(existsSync(installedPluginDir(stateDir, "demo"))).toBe(false);
  });

  it("lists subagent profiles with tools as hints", () => {
    installPluginFromDir(stateDir, writeClaudePlugin(join(base, "src")));
    const { profiles } = listPluginSubagents(stateDir);
    expect(profiles).toEqual([expect.objectContaining({ name: "demo:reviewer", tools: ["Read", "Grep"], model: "sonnet", prompt: "You review code.\n" })]);
  });
});
