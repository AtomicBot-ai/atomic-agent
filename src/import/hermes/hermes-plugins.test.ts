import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHermesPluginMcpServer,
  defaultPythonCommand,
  discoverHermesPlugins,
  hermesPluginServerName,
  hermesShimInstallPath,
  installHermesShim,
  isTrustedPlugin,
  resolvePackagedHermesShim,
} from "./hermes-plugins.js";
import { writeFakeHermesPlugin } from "./hermes-plugins-test-helpers.js";

describe("hermes plugin discovery", () => {
  let home: string;
  let plugins: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hermes-plugins-"));
    plugins = join(home, "plugins");
    mkdirSync(plugins, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns nothing when ~/.hermes/plugins is missing", () => {
    rmSync(plugins, { recursive: true, force: true });
    expect(discoverHermesPlugins(home)).toEqual([]);
  });

  it("finds flat and one-level category plugins with their manifest name", () => {
    writeFakeHermesPlugin(
      plugins,
      "calculator",
      "name: calc\ndescription: 'Math tools'\n",
    );
    writeFakeHermesPlugin(plugins, "image_gen/openai");
    const found = discoverHermesPlugins(home);
    expect(found.map((p) => [p.key, p.manifestName, p.description])).toEqual([
      ["calculator", "calc", "Math tools"],
      ["image_gen/openai", "openai", null],
    ]);
    expect(found[0]?.dir).toBe(join(plugins, "calculator"));
  });

  it("skips packages without __init__.py (portable / manifest-only)", () => {
    const dir = join(plugins, "portable");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.yaml"), "name: portable\n");
    writeFileSync(join(dir, "plugin.json"), "{}");
    expect(discoverHermesPlugins(home)).toEqual([]);
  });

  it("matches trust by key or manifest name only", () => {
    writeFakeHermesPlugin(plugins, "calculator", "name: calc\n");
    const [plugin] = discoverHermesPlugins(home);
    if (!plugin) throw new Error("plugin not found");
    expect(isTrustedPlugin(plugin, ["calculator"])).toBe(true);
    expect(isTrustedPlugin(plugin, ["calc"])).toBe(true);
    expect(isTrustedPlugin(plugin, ["calcu", "other"])).toBe(false);
    expect(isTrustedPlugin(plugin, [])).toBe(false);
  });
});

describe("hermesPluginServerName", () => {
  it("folds keys into the MCP namespace rule", () => {
    expect(hermesPluginServerName("disk-cleanup")).toBe("hermes-disk-cleanup");
    expect(hermesPluginServerName("image_gen/OpenAI")).toBe(
      "hermes-image-gen-openai",
    );
    const long = hermesPluginServerName("a-very-long-plugin-name-that-overflows");
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/);
  });
});

describe("buildHermesPluginMcpServer", () => {
  it("builds a validated stdio entry running the shim on the plugin dir", () => {
    const result = buildHermesPluginMcpServer(
      {
        key: "calculator",
        manifestName: "calc",
        description: null,
        dir: "/home/u/.hermes/plugins/calculator",
      },
      {
        shimPath: "/state/hermes-plugin-bridge/hermes_mcp_shim.py",
        pythonCommand: "python3",
        hermesHome: "/home/u/.hermes",
      },
    );
    expect(result.kind).toBe("server");
    if (result.kind !== "server") return;
    expect(result.server).toMatchObject({
      name: "hermes-calculator",
      enabled: true,
      transport: {
        kind: "stdio",
        command: "python3",
        args: [
          "/state/hermes-plugin-bridge/hermes_mcp_shim.py",
          "/home/u/.hermes/plugins/calculator",
        ],
        cwd: "/home/u/.hermes/plugins/calculator",
      },
      env: { HERMES_HOME: "/home/u/.hermes" },
    });
    // Default trust: every bridged call stays behind the approval gate.
    expect(result.server.trust ?? "approval_gated").toBe("approval_gated");
    expect(result.server.approval).toBeUndefined();
  });

  it("defaults the interpreter per platform", () => {
    expect(defaultPythonCommand("darwin")).toBe("python3");
    expect(defaultPythonCommand("linux")).toBe("python3");
    expect(defaultPythonCommand("win32")).toBe("python");
  });
});

describe("shim packaging", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "hermes-shim-state-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("resolves the shim shipped in assets/hermes-plugin-bridge", () => {
    const path = resolvePackagedHermesShim();
    expect(path).not.toBeNull();
    expect(path).toMatch(/hermes-plugin-bridge[\\/]hermes_mcp_shim\.py$/);
  });

  it("installs a copy under the state dir", () => {
    const source = resolvePackagedHermesShim();
    const dest = installHermesShim(stateDir, source);
    expect(dest).toBe(hermesShimInstallPath(stateDir));
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe(readFileSync(source!, "utf8"));
  });

  it("fails loudly when the shim is missing", () => {
    expect(() => installHermesShim(stateDir, null)).toThrow(/not found/);
  });
});

function hasPython3(): boolean {
  try {
    return spawnSync("python3", ["--version"]).status === 0;
  } catch {
    return false;
  }
}

describe.skipIf(!hasPython3())("hermes_mcp_shim.py over stdio", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hermes-shim-live-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("serves register_tool and register_command as MCP tools", () => {
    const dir = writeFakeHermesPlugin(join(home, "plugins"), "calc");
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "add", arguments: { a: 2, b: 3 } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "command_greet", arguments: { args: "bob" } },
      },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } },
    ];
    const run = spawnSync(
      "python3",
      [resolvePackagedHermesShim()!, dir],
      {
        input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect(run.status).toBe(0);
    const replies = run.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>);
    // One reply per request with an id; the notification gets none and the
    // plugin's print() went to stderr.
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(replies[0]?.result.protocolVersion).toBe("2025-06-18");
    expect(
      (replies[1]?.result.tools as { name: string }[]).map((t) => t.name),
    ).toEqual(["add", "command_greet"]);
    expect(replies[2]?.result).toEqual({
      content: [{ type: "text", text: '{"sum": 5}' }],
      isError: false,
    });
    expect(replies[3]?.result.content[0].text).toBe("hi bob");
    expect(replies[4]?.error.code).toBe(-32602);
    expect(run.stderr).toContain("register_hook is not supported");
  });
});
