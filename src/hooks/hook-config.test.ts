import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPluginFromDir } from "../plugins/plugin-install.js";
import { resetPluginCache } from "../plugins/plugin-runtime.js";
import { installedPluginDir, updatePluginRecord } from "../plugins/plugin-store.js";
import { writeClaudePlugin } from "../plugins/plugin-test-helpers.js";
import { loadAllHooks, loadPluginHooks, loadUserHooks, parseHooksObject, resetHooksCache, userHooksPath } from "./hook-config.js";

const user = { kind: "user" as const, file: "/s/hooks.json" };

describe("parseHooksObject", () => {
  it("reads the wrapped Claude format with seconds timeouts", () => {
    const { config, diagnostics } = parseHooksObject({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "a", timeout: 5 }, { type: "command", command: "b" }] }] } }, user);
    expect(diagnostics).toEqual([]);
    expect(config.PreToolUse?.[0]?.hooks.map((h) => h.timeoutMs)).toEqual([5_000, 60_000]);
  });

  it("reads the bare event map and a file-wide defaultTimeout", () => {
    const { config } = parseHooksObject({ defaultTimeout: 10, PostToolUse: [{ hooks: [{ type: "command", command: "x" }] }] }, user);
    expect(config.PostToolUse?.[0]).toMatchObject({ matcher: "", hooks: [{ timeoutMs: 10_000 }] });
  });

  it("skips unknown events and non-command hooks with diagnostics", () => {
    const { config, diagnostics } = parseHooksObject({ hooks: { Bogus: [], PreToolUse: [{ hooks: [{ type: "prompt", prompt: "x" }] }] } }, user);
    expect(config).toEqual({});
    expect(diagnostics.join("\n")).toMatch(/unknown hook event "Bogus"/);
    expect(diagnostics.join("\n")).toMatch(/only \{"type":"command"/);
  });
});

describe("hook files", () => {
  let base: string;
  let stateDir: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "atomic-hooks-"));
    stateDir = join(base, "state");
    resetPluginCache();
    resetHooksCache();
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("a missing user file is no hooks; broken JSON is a diagnostic", () => {
    expect(loadUserHooks(stateDir)).toEqual({ config: {}, diagnostics: [] });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(userHooksPath(stateDir), "{ nope");
    expect(loadUserHooks(stateDir).diagnostics[0]).toMatch(/not valid JSON/);
  });

  it("plugin hooks stay off until the plugin may run code", () => {
    installPluginFromDir(stateDir, writeClaudePlugin(join(base, "src"), { name: "guard", hooks: true }));
    const off = loadPluginHooks(stateDir);
    expect(off.config).toEqual({});
    expect(off.diagnostics.join("\n")).toMatch(/plugin guard: hooks not run.*atomic-agent plugin allow-code guard/);

    updatePluginRecord(stateDir, "guard", (rec) => ({ ...rec, runsCodeAccepted: true }));
    resetPluginCache();
    const on = loadPluginHooks(stateDir);
    const hook = on.config.PreToolUse?.[0]?.hooks[0];
    expect(hook?.command).toBe(`${installedPluginDir(stateDir, "guard")}/hooks/check.sh`);
    expect(hook?.source).toMatchObject({ kind: "plugin", plugin: "guard" });
  });

  it("an event the user switched off for a plugin is dropped", () => {
    installPluginFromDir(stateDir, writeClaudePlugin(join(base, "src"), { name: "guard", hooks: true }));
    updatePluginRecord(stateDir, "guard", (rec) => ({ ...rec, runsCodeAccepted: true, disabledParts: ["hook:PreToolUse"] }));
    resetPluginCache();
    expect(loadPluginHooks(stateDir).config).toEqual({});
  });

  it("merges user and plugin hooks, user first", () => {
    installPluginFromDir(stateDir, writeClaudePlugin(join(base, "src"), { name: "guard", hooks: true }));
    updatePluginRecord(stateDir, "guard", (rec) => ({ ...rec, runsCodeAccepted: true }));
    resetPluginCache();
    writeFileSync(userHooksPath(stateDir), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "mine" }] }] } }));
    const all = loadAllHooks(stateDir);
    expect(all.config.PreToolUse?.map((g) => g.hooks[0]?.source.kind)).toEqual(["user", "plugin"]);
  });
});
