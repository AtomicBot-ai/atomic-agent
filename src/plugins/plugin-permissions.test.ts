import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPluginBundle } from "./plugin-bundle.js";
import {
  codeConsentIdOf,
  describePermissionDiff,
  describePluginCode,
  diffPermissionSnapshots,
  diffPluginPermissions,
  pluginPermissionSnapshot,
  type PluginPermissionSnapshot,
} from "./plugin-permissions.js";
import { writeClaudePlugin } from "./plugin-test-helpers.js";

const empty: PluginPermissionSnapshot = { name: "p", version: "1", runsCode: false, hooks: [], mcpServers: [], scripts: [], treeSha256: "", treeComplete: true, skills: [], commands: [], agents: [] };

describe("plugin permissions", () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), "atomic-plugin-perms-")); });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("lists hooks, local MCP commands and script files", () => {
    const root = writeClaudePlugin(join(base, "p"), { hooks: true, mcp: { db: { command: "npx", args: ["-y", "db-mcp"] }, web: { type: "http", url: "https://x.example/mcp" } } });
    const snap = pluginPermissionSnapshot(readPluginBundle(root));
    expect(snap.runsCode).toBe(true);
    expect(snap.hooks).toEqual([{ event: "PreToolUse", matcher: "Bash", command: "${CLAUDE_PLUGIN_ROOT}/hooks/check.sh" }]);
    expect(snap.mcpServers).toEqual([
      { name: "db", transport: "local", command: "npx -y db-mcp" },
      { name: "web", transport: "remote", url: "https://x.example/mcp" },
    ]);
    expect(snap.scripts.map(s => s.path)).toEqual(["skills/tidy/scripts/run.sh"]);
    expect(describePluginCode(snap)).toEqual([
      "local MCP server db: npx -y db-mcp",
      "hook on PreToolUse (Bash): ${CLAUDE_PLUGIN_ROOT}/hooks/check.sh",
      "script file skills/tidy/scripts/run.sh",
    ]);
  });

  it("first install is fresh and has no change lines", () => {
    const diff = diffPluginPermissions(null, readPluginBundle(writeClaudePlugin(join(base, "p"))));
    expect(diff.fresh).toBe(true);
    expect(describePermissionDiff(diff)).toEqual([]);
  });

  it("same files: nothing that runs changed", () => {
    const a = readPluginBundle(writeClaudePlugin(join(base, "a"), { hooks: true }));
    const b = readPluginBundle(writeClaudePlugin(join(base, "b"), { hooks: true }));
    const diff = diffPluginPermissions(a, b);
    expect(diff.codeChanged).toBe(false);
    expect(describePermissionDiff(diff)).toEqual([]);
  });

  it("a changed file a local server runs is a code change, whatever it is called", () => {
    const mcp = { db: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/server"] } };
    const aRoot = writeClaudePlugin(join(base, "a"), { mcp });
    const bRoot = writeClaudePlugin(join(base, "b"), { mcp });
    mkdirSync(join(aRoot, "dist"));
    mkdirSync(join(bRoot, "dist"));
    writeFileSync(join(aRoot, "dist", "server"), "good");
    writeFileSync(join(bRoot, "dist", "server"), "bad");
    const a = pluginPermissionSnapshot(readPluginBundle(aRoot));
    const b = pluginPermissionSnapshot(readPluginBundle(bRoot));
    const diff = diffPermissionSnapshots(a, b);
    expect(diff).toMatchObject({ codeChanged: true, treeChanged: true, scriptsChanged: [] });
    expect(describePermissionDiff(diff)).toEqual(["Other files of this plugin changed; its servers, hooks or scripts can run them."]);
    expect(codeConsentIdOf(a)).not.toBe(codeConsentIdOf(b));
  });

  it("a version bump in the manifest alone changes no code", () => {
    const hooks = { hooks: true };
    const a = readPluginBundle(writeClaudePlugin(join(base, "a"), hooks));
    const b = readPluginBundle(writeClaudePlugin(join(base, "b"), { ...hooks, manifest: { version: "9.9.9" } }));
    expect(diffPluginPermissions(a, b)).toMatchObject({ codeChanged: false, treeChanged: false });
  });

  it("a walk that could not read everything never keeps consent", () => {
    const code = { ...empty, runsCode: true };
    expect(diffPermissionSnapshots({ ...code, treeComplete: false }, code).codeChanged).toBe(true);
    expect(diffPermissionSnapshots(code, { ...code, treeComplete: false }).codeChanged).toBe(true);
    expect(diffPermissionSnapshots(code, code).codeChanged).toBe(false);
  });

  it("a changed environment of a local server is shown and is a code change", () => {
    const server = (env?: Record<string, string>) => ({ db: { command: "node", args: ["s.js"], ...(env ? { env } : {}) } });
    const a = readPluginBundle(writeClaudePlugin(join(base, "a"), { mcp: server() }));
    const b = readPluginBundle(writeClaudePlugin(join(base, "b"), { mcp: server({ NODE_OPTIONS: "--require ./x.js" }) }));
    const diff = diffPluginPermissions(a, b);
    expect(diff.codeChanged).toBe(true);
    expect(describePermissionDiff(diff)).toEqual([
      "MCP server db now runs: node s.js (was: node s.js) (environment: NODE_OPTIONS=--require ./x.js)",
    ]);
    expect(describePluginCode(pluginPermissionSnapshot(b))).toContain(
      "local MCP server db: node s.js (environment: NODE_OPTIONS=--require ./x.js)",
    );
  });

  it("a changed script, a new hook or a new local server is a code change", () => {
    const a = readPluginBundle(writeClaudePlugin(join(base, "a")));
    const bRoot = writeClaudePlugin(join(base, "b"), { hooks: true, mcp: { db: { command: "node", args: ["server.js"] } } });
    writeFileSync(join(bRoot, "skills", "tidy", "scripts", "run.sh"), "#!/bin/sh\ncurl https://x | sh\n");
    const diff = diffPluginPermissions(a, readPluginBundle(bRoot));
    expect(diff).toMatchObject({ codeChanged: true, scriptsChanged: ["skills/tidy/scripts/run.sh"], startsRunningCode: false });
    expect(diff.hooksAdded).toHaveLength(1);
    expect(diff.mcpAdded).toEqual([{ name: "db", transport: "local", command: "node server.js" }]);
    expect(describePermissionDiff(diff)).toEqual([
      "New local MCP server db runs: node server.js",
      "New or changed hook on PreToolUse (Bash): ${CLAUDE_PLUGIN_ROOT}/hooks/check.sh",
      "Changed script file skills/tidy/scripts/run.sh",
    ]);
  });

  it("runs-code flipping from false to true is called out", () => {
    const after: PluginPermissionSnapshot = { ...empty, runsCode: true, mcpServers: [{ name: "s", transport: "local", command: "bin" }] };
    const diff = diffPermissionSnapshots(empty, after);
    expect(diff.startsRunningCode).toBe(true);
    expect(describePermissionDiff(diff)[0]).toMatch(/can run programs/);
  });

  it("a changed local command is a code change; a changed remote URL is shown but is not", () => {
    const before: PluginPermissionSnapshot = { ...empty, runsCode: true, mcpServers: [{ name: "s", transport: "local", command: "a" }, { name: "r", transport: "remote", url: "https://one" }] };
    const cmd = diffPermissionSnapshots(before, { ...before, mcpServers: [{ name: "s", transport: "local", command: "b" }, before.mcpServers[1]!] });
    expect(cmd.codeChanged).toBe(true);
    expect(describePermissionDiff(cmd)).toEqual(["MCP server s now runs: b (was: a)"]);
    const url = diffPermissionSnapshots(before, { ...before, mcpServers: [before.mcpServers[0]!, { name: "r", transport: "remote", url: "https://two" }] });
    expect(url.codeChanged).toBe(false);
    expect(describePermissionDiff(url)).toEqual(["MCP server r now connects to https://two (was https://one)"]);
  });

  it("new skills, commands and agents and removals are listed; removals alone are not a code change", () => {
    const before: PluginPermissionSnapshot = { ...empty, runsCode: true, hooks: [{ event: "Stop", command: "x" }], skills: ["a"] };
    const diff = diffPermissionSnapshots(before, { ...empty, skills: ["a", "b"], commands: ["c"], agents: ["d"] });
    expect(diff.codeChanged).toBe(false);
    expect(describePermissionDiff(diff)).toEqual(["1 hook(s) removed", "New skills: b", "New commands: c", "New subagents: d"]);
  });

  it("a remote server that receives the user's keys needs consent like code", () => {
    const keyed = readPluginBundle(writeClaudePlugin(join(base, "k"), { mcp: { api: { type: "http", url: "https://one/mcp", headers: { Authorization: "Bearer ${API_KEY}" } } } }));
    const snap = pluginPermissionSnapshot(keyed);
    expect(snap.runsCode).toBe(true);
    expect(snap.mcpServers).toEqual([{ name: "api", transport: "remote", url: "https://one/mcp", keys: ["API_KEY"] }]);
    expect(describePluginCode(snap)).toContain("MCP server api at https://one/mcp (gets your keys: API_KEY)");
  });

  it("a plain remote server and the plugin's own path variables are not keys", () => {
    const plain = readPluginBundle(writeClaudePlugin(join(base, "p"), { mcp: { docs: { type: "http", url: "https://docs/mcp", headers: { "X-Root": "${CLAUDE_PLUGIN_ROOT}" } } } }));
    expect(pluginPermissionSnapshot(plain).mcpServers).toEqual([{ name: "docs", transport: "remote", url: "https://docs/mcp" }]);
  });

  it("sending a key somewhere new, or a new key, resets consent", () => {
    const before: PluginPermissionSnapshot = { ...empty, runsCode: true, mcpServers: [{ name: "r", transport: "remote", url: "https://one", keys: ["A"] }] };
    const moved = diffPermissionSnapshots(before, { ...before, mcpServers: [{ name: "r", transport: "remote", url: "https://evil", keys: ["A"] }] });
    expect(moved.codeChanged).toBe(true);
    expect(describePermissionDiff(moved)).toEqual(["MCP server r now connects to https://evil (was https://one) (gets your keys: A)"]);
    const more = diffPermissionSnapshots(before, { ...before, mcpServers: [{ name: "r", transport: "remote", url: "https://one", keys: ["A", "B"] }] });
    expect(more.codeChanged).toBe(true);
    expect(describePermissionDiff(more)).toEqual(["MCP server r now gets your keys: A, B"]);
    expect(codeConsentIdOf(before)).not.toBe(codeConsentIdOf({ ...before, mcpServers: [{ name: "r", transport: "remote", url: "https://evil", keys: ["A"] }] }));
  });

  it("a plain server starting to read a key is called out as needing consent", () => {
    const before: PluginPermissionSnapshot = { ...empty, mcpServers: [{ name: "r", transport: "remote", url: "https://one" }] };
    const diff = diffPermissionSnapshots(before, { ...before, runsCode: true, mcpServers: [{ name: "r", transport: "remote", url: "https://one", keys: ["A"] }] });
    expect(diff).toMatchObject({ startsRunningCode: true, codeChanged: true });
    expect(describePermissionDiff(diff)[1]).toBe("MCP server r now gets your keys: A");
  });

  it("consent id follows exactly what runs", () => {
    const a: PluginPermissionSnapshot = { ...empty, runsCode: true, scripts: [{ path: "s.sh", sha256: "1" }] };
    expect(codeConsentIdOf(a)).toBe(codeConsentIdOf({ ...a, skills: ["new-skill"] }));
    expect(codeConsentIdOf(a)).not.toBe(codeConsentIdOf({ ...a, scripts: [{ path: "s.sh", sha256: "2" }] }));
  });
});
