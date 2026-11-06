import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPluginFromDir } from "./plugin-install.js";
import { expandVars, loadPluginMcpServers, uniqueName } from "./plugin-mcp.js";
import { resetPluginCache } from "./plugin-runtime.js";
import { installedPluginDir } from "./plugin-store.js";
import { writeClaudePlugin } from "./plugin-test-helpers.js";

describe("plugin MCP servers", () => {
  let base: string;
  let stateDir: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "atomic-plugin-mcp-"));
    stateDir = join(base, "state");
    resetPluginCache();
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("maps .mcp.json servers with plugin-prefixed names and expanded root", () => {
    installPluginFromDir(stateDir, writeClaudePlugin(join(base, "src"), {
      mcp: {
        local: { command: "${CLAUDE_PLUGIN_ROOT}/bin/server", args: ["--data", "${CLAUDE_PLUGIN_DATA}"] },
        remote: { type: "http", url: "https://example.invalid/mcp", trust: "pure_read" },
        broken: { type: "ws" },
      },
    }), { acceptCode: true });
    const { servers, skipped } = loadPluginMcpServers(stateDir);
    const byName = Object.fromEntries(servers.map(s => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual(["demo-local", "demo-remote"]);
    const local = byName["demo-local"]!.transport as { command: string; args: string[] };
    expect(local.command).toBe(join(installedPluginDir(stateDir, "demo"), "bin/server"));
    expect(local.args[1]).toBe(join(stateDir, "plugins", "data", "demo"));
    expect(byName["demo-local"]!.trust).toBeUndefined();
    expect(byName["demo-remote"]!.trust).toBeUndefined();
    expect(skipped.map(s => s.server)).toEqual(["broken"]);
  });

  it("skips local (stdio) servers until code is allowed for the plugin", () => {
    installPluginFromDir(stateDir, writeClaudePlugin(join(base, "src"), {
      mcp: { local: { command: "node", args: ["s.js"] }, remote: { type: "http", url: "https://example.invalid/mcp" } },
    }));
    const { servers, skipped } = loadPluginMcpServers(stateDir);
    expect(servers.map(s => s.name)).toEqual(["demo-remote"]);
    expect(skipped).toEqual([expect.objectContaining({ server: "local", reason: expect.stringContaining("allow-code") })]);
  });

  it("never reuses a taken server name", () => {
    expect(uniqueName("demo-local", new Set(["demo-local"]))).toBe("demo-local-2");
    expect(uniqueName("A Very Long Plugin Name-with-a-long-server", new Set())!.length).toBeLessThanOrEqual(32);
    expect(uniqueName("!", new Set())).toBeNull();
  });

  it("expands variables inside nested values only", () => {
    expect(expandVars({ a: ["${PLUGIN_ROOT}/x"], b: 1, c: "${HOME}" }, { root: "/r", data: "/d" })).toEqual({ a: ["/r/x"], b: 1, c: "${HOME}" });
  });
});
