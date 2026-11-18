import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectTrustRecord } from "../config/skills-config.js";
import {
  builtinAgentProfileSet,
  listProjectAgentProfilePaths,
  loadAgentProfiles,
  type AgentProfileLoadOptions,
} from "./profile-loader.js";

describe("loadAgentProfiles (ATO-566)", () => {
  let base: string;
  let repo: string;
  let state: string;
  let configFile: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "agent-profiles-")));
    repo = join(base, "repo");
    state = join(base, "state");
    mkdirSync(repo);
    mkdirSync(state);
    // Unreadable on purpose: the loader falls back to the startup trust
    // snapshot passed in, which is what these tests control.
    configFile = join(base, "config.json");
    writeFileSync(configFile, "not json");
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function put(dir: string, file: string, content: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  function trust(paths: string[]): ProjectTrustRecord[] {
    return [{ workingDir: repo, trustedSkills: [], declinedSkills: [], trustedInstructions: paths, declinedInstructions: [] }];
  }
  function load(over: Partial<AgentProfileLoadOptions> = {}) {
    return loadAgentProfiles({ workingDir: repo, stateDir: state, configFile, startupTrust: [], ...over });
  }

  it("has the three built-ins with nothing on disk", () => {
    const set = load();
    expect(set.profiles.map((p) => p.name)).toEqual(["explore", "research", "review"]);
    expect(set.diagnostics).toEqual([]);
    expect(builtinAgentProfileSet().profiles.map((p) => p.name)).toEqual(["explore", "research", "review"]);
  });

  it("loads user profiles, and a user file replaces a built-in of the same name", () => {
    put(join(state, "agents"), "review.md", "---\nname: review\n---\nMY REVIEW");
    put(join(state, "agents"), "writer.md", "---\ndescription: writes\n---\nWRITE");
    const set = load();
    expect(set.get("review")).toMatchObject({ source: "user", prompt: "MY REVIEW" });
    expect(set.get("Writer")).toMatchObject({ source: "user", description: "writes" });
  });

  it("withholds project profiles until their path is trusted, then loads .atomic-agent before .claude", () => {
    put(join(repo, ".atomic-agent/agents"), "deploy.md", "---\nname: deploy\n---\nOURS");
    put(join(repo, ".claude/agents"), "deploy.md", "---\nname: deploy\n---\nCLAUDE");
    put(join(repo, ".claude/agents"), "notes.txt", "ignored");
    expect(listProjectAgentProfilePaths(repo)).toEqual([".atomic-agent/agents/deploy.md", ".claude/agents/deploy.md"]);

    const pending = load();
    expect(pending.get("deploy")).toBeUndefined();
    expect(pending.withheld).toEqual([".atomic-agent/agents/deploy.md", ".claude/agents/deploy.md"]);

    const trusted = load({ startupTrust: trust([".atomic-agent/agents/deploy.md", ".claude/agents/deploy.md"]) });
    expect(trusted.get("deploy")).toMatchObject({ source: "project", prompt: "OURS" });
    expect(trusted.diagnostics.join("\n")).toContain("shadowed");
  });

  it("trusts by file: an untrusted file next to a trusted one stays out", () => {
    put(join(repo, ".claude/agents"), "a.md", "A");
    put(join(repo, ".claude/agents"), "b.md", "B");
    const set = load({ startupTrust: trust([".claude/agents/a.md"]) });
    expect(set.get("a")?.prompt).toBe("A");
    expect(set.get("b")).toBeUndefined();
    expect(set.withheld).toEqual([".claude/agents/b.md"]);
  });

  it("a trusted project profile wins over the user's of the same name; an untrusted one leaves the user's", () => {
    put(join(state, "agents"), "deploy.md", "USER");
    put(join(repo, ".claude/agents"), "deploy.md", "PROJECT");
    const trusted = load({ startupTrust: trust([".claude/agents/deploy.md"]) });
    expect(trusted.get("deploy")).toMatchObject({ source: "project", prompt: "PROJECT" });
    expect(trusted.diagnostics.join("\n")).toContain("shadowed");
    const untrusted = load();
    expect(untrusted.get("deploy")).toMatchObject({ source: "user", prompt: "USER" });
    expect(untrusted.withheld).toEqual([".claude/agents/deploy.md"]);
  });

  it("opened in the folder that holds the state dir, the user's profiles stay the user's, never pending", () => {
    const home = join(base, "home");
    const homeState = join(home, ".atomic-agent");
    put(join(homeState, "agents"), "mine.md", "MINE");
    const set = loadAgentProfiles({ workingDir: home, stateDir: homeState, configFile, startupTrust: [] });
    expect(set.get("mine")).toMatchObject({ source: "user", prompt: "MINE" });
    expect(set.withheld).toEqual([]);
    expect(listProjectAgentProfilePaths(home, homeState)).toEqual([]);
  });

  it("does not follow a project profile folder out of the workspace", () => {
    const outside = join(base, "outside");
    put(outside, "evil.md", "EVIL");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    symlinkSync(outside, join(repo, ".claude/agents"));
    const set = load({ startupTrust: trust([".claude/agents/evil.md"]) });
    expect(set.get("evil")).toBeUndefined();
    expect(set.diagnostics.join("\n")).toContain("outside the workspace");
    expect(listProjectAgentProfilePaths(repo)).toEqual([]);
  });

  it("reports a broken file as a diagnostic and keeps the rest", () => {
    put(join(state, "agents"), "broken.md", "---\nname: [x\n---\nB");
    put(join(state, "agents"), "fine.md", "FINE");
    const set = load();
    expect(set.get("fine")?.prompt).toBe("FINE");
    expect(set.diagnostics.join("\n")).toContain("broken.md");
  });

  it("adds plugin profiles and survives a plugin listing that throws", () => {
    const withPlugin = load({
      pluginProfiles: () => [{ name: "kit:helper", description: "", prompt: "HELP", source: "plugin" }],
    });
    expect(withPlugin.get("kit:helper")?.prompt).toBe("HELP");
    const failing = load({ pluginProfiles: () => { throw new Error("boom"); } });
    expect(failing.get("explore")).toBeDefined();
    expect(failing.diagnostics.join("\n")).toContain("boom");
  });

  describe("settings profiles (ATO-1668)", () => {
    it("loads an entry as a profile with the settings source and no file", () => {
      const set = load({
        settingsProfiles: () => ({ writer: { description: "writes", prompt: "  WRITE  ", model: "build", tools: ["Read"] } }),
      });
      expect(set.get("writer")).toEqual({
        name: "writer",
        description: "writes",
        prompt: "WRITE",
        model: "build",
        tools: ["Read"],
        source: "settings",
      });
    });

    it("a settings profile replaces a built-in of the same name", () => {
      const set = load({ settingsProfiles: () => ({ review: { prompt: "SETTINGS REVIEW" } }) });
      expect(set.get("review")).toMatchObject({ source: "settings", prompt: "SETTINGS REVIEW" });
    });

    it("a trusted project file of the same name beats the settings", () => {
      put(join(repo, ".claude/agents"), "review.md", "PROJECT");
      const set = load({
        startupTrust: trust([".claude/agents/review.md"]),
        settingsProfiles: () => ({ review: { prompt: "SETTINGS" } }),
      });
      expect(set.get("review")).toMatchObject({ source: "project", prompt: "PROJECT" });
      expect(set.diagnostics.join("\n")).toContain("llm.runMode.agentProfiles.review is shadowed by");
    });

    it("an untrusted project file leaves the settings profile in place", () => {
      put(join(repo, ".claude/agents"), "review.md", "PROJECT");
      const set = load({ settingsProfiles: () => ({ review: { prompt: "SETTINGS" } }) });
      expect(set.get("review")).toMatchObject({ source: "settings", prompt: "SETTINGS" });
      expect(set.withheld).toEqual([".claude/agents/review.md"]);
    });

    it("a user file of the same name beats the settings", () => {
      put(join(state, "agents"), "deploy.md", "USER");
      const set = load({ settingsProfiles: () => ({ deploy: { prompt: "SETTINGS" } }) });
      expect(set.get("deploy")).toMatchObject({ source: "user", prompt: "USER" });
    });

    it("the settings beat a plugin profile of the same name", () => {
      // Pins pass order only: real plugin profiles are named `plugin:agent`
      // and a settings name cannot hold ":", so the two never collide.
      const set = load({
        settingsProfiles: () => ({ deploy: { prompt: "SETTINGS" } }),
        pluginProfiles: () => [{ name: "deploy", description: "", prompt: "PLUGIN", source: "plugin" }],
      });
      expect(set.get("deploy")).toMatchObject({ source: "settings", prompt: "SETTINGS" });
      expect(set.diagnostics.join("\n")).toContain("shadowed by llm.runMode.agentProfiles.deploy");
    });

    it("reports a bad entry as a diagnostic and keeps the others", () => {
      const set = load({
        settingsProfiles: () =>
          ({ broken: { prompt: "   " }, "bad name!": { prompt: "X" }, fine: { prompt: "FINE" } }),
      });
      expect(set.get("fine")?.prompt).toBe("FINE");
      expect(set.get("broken")).toBeUndefined();
      const text = set.diagnostics.join("\n");
      expect(text).toContain("llm.runMode.agentProfiles.broken");
      expect(text).toContain("llm.runMode.agentProfiles.bad name!");
    });

    it("calls the settings reader on every load and survives one that throws", () => {
      let prompt = "FIRST";
      const options = { settingsProfiles: () => ({ writer: { prompt } }) };
      expect(load(options).get("writer")?.prompt).toBe("FIRST");
      prompt = "SECOND";
      expect(load(options).get("writer")?.prompt).toBe("SECOND");
      const failing = load({ settingsProfiles: () => { throw new Error("config gone"); } });
      expect(failing.get("explore")).toBeDefined();
      expect(failing.diagnostics.join("\n")).toContain("config gone");
      expect(load({ settingsProfiles: () => undefined }).profiles.map((p) => p.name)).toEqual(["explore", "research", "review"]);
    });
  });
});
