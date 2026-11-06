import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPluginBundle } from "./plugin-bundle.js";
import { installPluginFromDir, setPluginCodeAllowed, setPluginPartEnabled } from "./plugin-install.js";
import {
  buildPluginOverview,
  formatPluginCounts,
  hookEventNames,
  loadPluginOverviews,
  missingMcpKeys,
  pluginCodeParts,
  pluginTrust,
  readPluginHookEvents,
} from "./plugin-overview.js";
import { installedPluginDir, readPluginState, type InstalledPluginRecord } from "./plugin-store.js";
import { writeClaudePlugin } from "./plugin-test-helpers.js";

const RECORD: InstalledPluginRecord = {
  name: "demo",
  version: "1.2.0",
  enabled: true,
  source: { kind: "local", path: "/src/demo" },
  installedAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

describe("missingMcpKeys", () => {
  it("names unset or empty ${VAR} references in env, headers and url", () => {
    const entry = {
      command: "npx",
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", REGION: "${REGION:-eu}", ROOT: "${CLAUDE_PLUGIN_ROOT}/x", PLAIN: "value" },
      headers: { Authorization: "Bearer ${API_KEY}", "X-Empty": "" },
      url: "https://example.invalid/?k=${URL_KEY}",
    };
    expect(missingMcpKeys(entry, {})).toEqual(["API_KEY", "GITHUB_TOKEN", "URL_KEY", "X-Empty"]);
    expect(missingMcpKeys(entry, { GITHUB_TOKEN: "t", API_KEY: "k", URL_KEY: "u" })).toEqual(["X-Empty"]);
    expect(missingMcpKeys(entry, { GITHUB_TOKEN: "", API_KEY: "k", URL_KEY: "u" })).toEqual(["GITHUB_TOKEN", "X-Empty"]);
  });

  it("checks command and args like the loader does, and ignores non-string values", () => {
    expect(missingMcpKeys({ command: "x", args: ["${ARG_KEY}", "${OK:-1}"] }, {})).toEqual(["ARG_KEY"]);
    expect(missingMcpKeys({ env: { N: 3 }, headers: ["nope"] }, {})).toEqual([]);
  });
});

describe("hookEventNames", () => {
  it("reads the hooks.json envelope and a bare event map", () => {
    expect(hookEventNames({ description: "x", hooks: { Stop: [], PreToolUse: [{}] } })).toEqual(["PreToolUse", "Stop"]);
    expect(hookEventNames({ SessionStart: [{}], description: "d" })).toEqual(["SessionStart"]);
    expect(hookEventNames(null)).toEqual([]);
    expect(hookEventNames([1, 2])).toEqual([]);
  });
});

describe("pluginTrust", () => {
  it("only asks about code when the plugin runs any", () => {
    expect(pluginTrust(false, false)).toBe("no-code");
    expect(pluginTrust(false, true)).toBe("no-code");
    expect(pluginTrust(true, true)).toBe("code-allowed");
    expect(pluginTrust(true, false)).toBe("code-off");
  });
});

describe("buildPluginOverview", () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), "atomic-plugin-overview-")); });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("counts every part and gives each the id the part toggles use", () => {
    const root = writeClaudePlugin(join(base, "p"), {
      mcp: { gh: { command: "npx", env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } }, docs: { type: "http", url: "https://docs.invalid/mcp" } },
      hooks: true,
    });
    const bundle = readPluginBundle(root);
    const o = buildPluginOverview(RECORD, bundle, { env: {}, hookEvents: readPluginHookEvents(bundle) });
    expect(o.counts).toEqual({ skills: 2, mcpServers: 2, hooks: 1, commands: 2, agents: 1 });
    expect(o.parts.map(p => p.id)).toEqual([
      "skill:review", "skill:tidy", "mcp:gh", "mcp:docs", "hook:PreToolUse", "command:commit", "command:git:push", "agent:reviewer",
    ]);
    expect(o.parts.filter(p => p.runsCode).map(p => p.id)).toEqual(["skill:tidy", "mcp:gh", "hook:PreToolUse"]);
    expect(o.runsCode).toBe(true);
    expect(o.trust).toBe("code-off");
    expect(o.codeParts).toEqual(["local MCP servers: gh", "hooks", "skill scripts: tidy"]);
    expect(o.needsKey).toBe(true);
    expect(o.missingKeys).toEqual(["GITHUB_TOKEN"]);
    expect(o.sourceLabel).toBe("folder /src/demo");
    expect(o.description).toBe("Demo plugin");
    expect(formatPluginCounts(o.counts)).toBe("2 skills, 2 MCP servers, 1 hook, 2 commands, 1 subagent");
  });

  it("marks code-running parts inactive until code is allowed, and everything inactive when the plugin is off", () => {
    const root = writeClaudePlugin(join(base, "p"), { mcp: { gh: { command: "npx" } } });
    const bundle = readPluginBundle(root);
    const off = buildPluginOverview(RECORD, bundle);
    expect(off.parts.filter(p => !p.active).map(p => p.id)).toEqual(["skill:tidy", "mcp:gh"]);
    const allowed = buildPluginOverview({ ...RECORD, runsCodeAccepted: true }, bundle);
    expect(allowed.trust).toBe("code-allowed");
    expect(allowed.parts.every(p => p.active)).toBe(true);
    const disabled = buildPluginOverview({ ...RECORD, enabled: false, runsCodeAccepted: true }, bundle);
    expect(disabled.parts.some(p => p.active)).toBe(false);
  });

  it("reflects switched-off parts and drops their keys from the plugin-level mark", () => {
    const root = writeClaudePlugin(join(base, "p"), { mcp: { gh: { command: "npx", env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } } } });
    const bundle = readPluginBundle(root);
    const o = buildPluginOverview({ ...RECORD, disabledParts: ["mcp:gh", "skill:review"] }, bundle, { env: {} });
    expect(o.parts.find(p => p.id === "mcp:gh")).toMatchObject({ enabled: false, active: false, missingKeys: ["GITHUB_TOKEN"] });
    expect(o.parts.find(p => p.id === "skill:review")?.enabled).toBe(false);
    expect(o.needsKey).toBe(false);
  });

  it("reports a plugin with no code as no-code and a root skill under the plugin's name", () => {
    const o = buildPluginOverview(RECORD, {
      ...readPluginBundle(writeClaudePlugin(join(base, "p"))),
      skills: [{ name: "", dir: "/x", hasScripts: false }],
      commands: [],
      agents: [],
    });
    expect(o.parts).toEqual([{ id: "skill:demo", kind: "skill", active: true, name: "demo", enabled: true, runsCode: false, missingKeys: [] }]);
    expect(o.trust).toBe("no-code");
    expect(o.codeParts).toEqual([]);
  });

  it("degrades to an error row when the files cannot be read", () => {
    const o = buildPluginOverview(RECORD, null, { bundleError: "gone" });
    expect(o).toMatchObject({ filesOk: false, error: "gone", parts: [], needsKey: false, trust: "no-code" });
  });
});

describe("loadPluginOverviews", () => {
  let base: string;
  let stateDir: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "atomic-plugin-overviews-"));
    stateDir = join(base, "state");
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("lists installed plugins with toggles and code consent as written by the shared writers", () => {
    installPluginFromDir(stateDir, writeClaudePlugin(join(base, "src"), { mcp: { gh: { command: "npx" } }, hooks: true }));
    setPluginPartEnabled(stateDir, "demo", "hook:PreToolUse", false);
    setPluginCodeAllowed(stateDir, "demo", true);
    expect(readPluginState(stateDir).plugins.demo?.runsCodeAccepted).toBe(true);
    const [o] = loadPluginOverviews(stateDir, {});
    expect(o?.name).toBe("demo");
    expect(o?.trust).toBe("code-allowed");
    expect(o?.parts.find(p => p.id === "hook:PreToolUse")).toMatchObject({ enabled: false, active: false });
    expect(o?.parts.find(p => p.id === "mcp:gh")).toMatchObject({ enabled: true, active: true });
  });

  it("keeps a plugin whose folder disappeared, as an error row", () => {
    installPluginFromDir(stateDir, writeClaudePlugin(join(base, "src")));
    rmSync(installedPluginDir(stateDir, "demo"), { recursive: true, force: true });
    const [o] = loadPluginOverviews(stateDir, {});
    expect(o).toMatchObject({ name: "demo", filesOk: false });
    expect(o?.error).toBeTruthy();
  });

  it("lists the same code parts the CLI consent line shows", () => {
    const bundle = readPluginBundle(writeClaudePlugin(join(base, "p"), { hooks: true }));
    expect(pluginCodeParts(bundle)).toEqual(["hooks", "skill scripts: tidy"]);
  });
});
