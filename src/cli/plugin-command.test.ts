import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetConfigCache } from "../config/index.js";
import { installPluginFromDir, readPluginState } from "../plugins/index.js";
import { writeClaudePlugin } from "../plugins/plugin-test-helpers.js";
import { pluginCommand } from "./plugin-command.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";

describe("atomic-agent plugin (ATO-954 additions)", () => {
  let base: string;
  let stateDir: string;
  let originalEnv: string | undefined;
  let out: string[];

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "plugin-cmd-"));
    stateDir = join(base, "state");
    originalEnv = process.env[STATE_DIR_ENV];
    process.env[STATE_DIR_ENV] = stateDir;
    resetConfigCache();
    installPluginFromDir(stateDir, writeClaudePlugin(join(base, "src"), { mcp: { gh: { command: "npx" } } }));
    out = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { out.push(String(line)); });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = originalEnv;
    resetConfigCache();
    rmSync(base, { recursive: true, force: true });
  });

  it("prints the shared overview with list --json and show --json", async () => {
    expect(await pluginCommand(["list", "--json"])).toBe(0);
    const listed = JSON.parse(out.join("\n")) as { plugins: Array<{ name: string; trust: string; parts: Array<{ id: string }> }> };
    expect(listed.plugins.map((p) => [p.name, p.trust])).toEqual([["demo", "code-off"]]);
    expect(listed.plugins[0]?.parts.map((p) => p.id)).toContain("mcp:gh");

    out = [];
    expect(await pluginCommand(["show", "demo", "--json"])).toBe(0);
    expect(JSON.parse(out.join("\n")).plugin.name).toBe("demo");

    out = [];
    expect(await pluginCommand(["show", "--json", "nope"])).toBe(1);
    expect(JSON.parse(out.join("\n")).error).toBe("plugin not installed: nope");
  });

  it("switches one part with --part and refuses a malformed part id", async () => {
    expect(await pluginCommand(["disable", "demo", "--part", "mcp:gh"])).toBe(0);
    expect(readPluginState(stateDir).plugins.demo?.disabledParts).toEqual(["mcp:gh"]);
    expect(readPluginState(stateDir).plugins.demo?.enabled).toBe(true);
    expect(await pluginCommand(["enable", "--part", "mcp:gh", "demo"])).toBe(0);
    expect(readPluginState(stateDir).plugins.demo?.disabledParts).toEqual([]);
    expect(await pluginCommand(["disable", "demo", "--part", "bogus"])).toBe(2);
  });

  it("allow-code and deny-code write runsCodeAccepted", async () => {
    expect(await pluginCommand(["allow-code", "demo"])).toBe(0);
    expect(readPluginState(stateDir).plugins.demo?.runsCodeAccepted).toBe(true);
    expect(await pluginCommand(["deny-code", "demo"])).toBe(0);
    expect(readPluginState(stateDir).plugins.demo?.runsCodeAccepted).toBe(false);
  });
});
