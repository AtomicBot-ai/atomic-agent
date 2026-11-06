import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleRunsCode, readPluginBundle } from "./plugin-bundle.js";
import { detectPluginFormat, PluginManifestError } from "./plugin-manifest.js";
import { writeClaudePlugin } from "./test-plugin-fixture.js";

describe("readPluginBundle", () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), "atomic-plugin-")); });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("reads skills, commands, agents, hooks and MCP from a Claude plugin", () => {
    const root = writeClaudePlugin(join(base, "p"), { mcp: { gh: { command: "npx", args: ["gh-mcp"] } }, hooks: true });
    const b = readPluginBundle(root);
    expect(b.format).toBe("claude");
    expect(b.name).toBe("demo");
    expect(b.manifest.version).toBe("1.2.0");
    expect(b.skills.map(s => [s.name, s.hasScripts])).toEqual([["review", false], ["tidy", true]]);
    expect(b.commands.map(c => c.name)).toEqual(["commit", "git:push"]);
    expect(b.agents.map(a => a.name)).toEqual(["reviewer"]);
    expect(b.hooksFile).toMatch(/hooks\.json$/);
    expect(Object.keys(b.mcpServers)).toEqual(["gh"]);
    expect(bundleRunsCode(b)).toBe(true);
  });

  it("detects the formats in OpenClaw order and the manifest-less layout", () => {
    const codex = join(base, "codex");
    mkdirSync(join(codex, ".codex-plugin"), { recursive: true });
    writeFileSync(join(codex, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "cx" }));
    expect(detectPluginFormat(codex)?.format).toBe("codex");
    const bare = join(base, "My Bare_Plugin");
    mkdirSync(join(bare, "skills", "a"), { recursive: true });
    writeFileSync(join(bare, "skills", "a", "SKILL.md"), "---\nname: a\ndescription: d\n---\n");
    const b = readPluginBundle(bare);
    expect(b.format).toBe("conventional");
    expect(b.name).toBe("my-bare-plugin");
    expect(bundleRunsCode(b)).toBe(false);
    expect(detectPluginFormat(join(base, "nothing"))).toBeNull();
  });

  it("refuses manifest paths that leave the plugin folder", () => {
    const root = writeClaudePlugin(join(base, "evil"), { manifest: { skills: "../../outside" } });
    expect(() => readPluginBundle(root)).toThrow(PluginManifestError);
  });

  it("refuses a name that is not kebab-case", () => {
    const root = writeClaudePlugin(join(base, "bad"), { name: "Bad Name" });
    expect(() => readPluginBundle(root)).toThrow(/kebab-case/);
  });

  it("turns unsupported manifest keys and subagents into notes", () => {
    const root = writeClaudePlugin(join(base, "n"), { manifest: { outputStyles: "./styles" } });
    const notes = readPluginBundle(root).notes.join("\n");
    expect(notes).toContain("outputStyles");
    expect(notes).toContain("subagent");
  });

  it("treats a root SKILL.md as a single-skill plugin", () => {
    const root = join(base, "solo");
    mkdirSync(join(root, "skills"), { recursive: true });
    writeFileSync(join(root, "SKILL.md"), "---\nname: solo\ndescription: d\n---\n");
    const b = readPluginBundle(root);
    expect(b.skills).toEqual([{ name: "", dir: root, hasScripts: false }]);
  });
});
