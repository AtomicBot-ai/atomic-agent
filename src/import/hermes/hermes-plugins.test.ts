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
  resolvePackagedHermesShim,
  resolveTrustedPlugins,
  scanRequiredEnv,
} from "./hermes-plugins.js";
import {
  writeFakeHermesPlugin,
  writeHermesPluginSource,
} from "./hermes-plugins-test-helpers.js";

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

  it("matches trust by key, or by a unique manifest name", () => {
    writeFakeHermesPlugin(plugins, "calculator", "name: calc\n");
    const found = discoverHermesPlugins(home);
    const keys = (names: string[]) => [
      ...resolveTrustedPlugins(found, names).trustedKeys,
    ];
    expect(keys(["calculator"])).toEqual(["calculator"]);
    expect(keys(["calc"])).toEqual(["calculator"]);
    expect(keys([])).toEqual([]);
    const miss = resolveTrustedPlugins(found, ["calcu", "other"]);
    expect([...miss.trustedKeys]).toEqual([]);
    expect(miss.unmatched).toEqual(["calcu", "other"]);
  });

  it("never lets a manifest name borrow another plugin's folder name", () => {
    // plugins/weather declares `name: calculator`; trusting "calculator"
    // means the folder plugins/calculator only.
    writeFakeHermesPlugin(plugins, "calculator");
    writeFakeHermesPlugin(plugins, "weather", "name: calculator\n");
    const found = discoverHermesPlugins(home);
    const res = resolveTrustedPlugins(found, ["calculator"]);
    expect([...res.trustedKeys]).toEqual(["calculator"]);
    expect(res.ambiguous).toEqual([]);
  });

  it("reports a manifest name shared by several plugins as ambiguous", () => {
    writeFakeHermesPlugin(plugins, "a/calculator");
    writeFakeHermesPlugin(plugins, "b/calculator");
    const found = discoverHermesPlugins(home);
    const res = resolveTrustedPlugins(found, ["calculator"]);
    expect([...res.trustedKeys]).toEqual([]);
    expect(res.ambiguous).toEqual([
      { name: "calculator", keys: ["a/calculator", "b/calculator"] },
    ]);
    // The folder key still works.
    expect([
      ...resolveTrustedPlugins(found, ["b/calculator"]).trustedKeys,
    ]).toEqual(["b/calculator"]);
  });

  it("lists the env names the plugin's tools require", () => {
    const dir = writeHermesPluginSource(
      plugins,
      "weather",
      [
        "def register(ctx):",
        "    ctx.register_tool(name='w', toolset='t', schema={}, handler=None,",
        "        requires_env=['WEATHER_API_KEY', \"WEATHER_REGION\"])",
        "",
      ].join("\n"),
    );
    mkdirSync(join(dir, "sub"));
    writeFileSync(
      join(dir, "sub", "more.py"),
      "X = dict(requires_env=('EXTRA_KEY',))\n",
    );
    expect(scanRequiredEnv(dir)).toEqual([
      "EXTRA_KEY",
      "WEATHER_API_KEY",
      "WEATHER_REGION",
    ]);
    expect(discoverHermesPlugins(home)[0]?.requiredEnv).toEqual([
      "EXTRA_KEY",
      "WEATHER_API_KEY",
      "WEATHER_REGION",
    ]);
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
        requiredEnv: [],
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
      // UTF-8 stdio on Windows, where pipes default to the ANSI code page.
      env: {
        HERMES_HOME: "/home/u/.hermes",
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
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

  function runShim(
    dir: string,
    input: string | Buffer,
    env: Record<string, string> = {},
  ) {
    return spawnSync("python3", [resolvePackagedHermesShim()!, dir], {
      input,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, ...env },
    });
  }

  function call(id: number, name: string, args: Record<string, unknown>) {
    return JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });
  }

  function parseReplies(stdout: string): Record<string, any>[] {
    return stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>);
  }

  const ECHO_PLUGIN = [
    "import json, os, subprocess, sys",
    "def echo(args, **kw):",
    "    return json.dumps({'text': args['text']}, ensure_ascii=False)",
    "def noisy(args, **kw):",
    "    # No trailing newline: would glue onto the next JSON-RPC line.",
    "    os.system('printf stray-child-output')",
    "    subprocess.run([sys.executable, '-c', 'print(\"child print\")'])",
    "    return 'ok'",
    "def register(ctx):",
    "    ctx.register_tool(name='echo', toolset='t', schema={'parameters': {",
    "        'type': 'object', 'properties': {'text': {'type': 'string'}}}},",
    "        handler=echo)",
    "    ctx.register_tool(name='noisy', toolset='t', schema={}, handler=noisy)",
    "",
  ].join("\n");

  it("keeps child-process stdout out of the protocol stream", () => {
    const dir = writeHermesPluginSource(join(home, "plugins"), "p", ECHO_PLUGIN);
    const run = runShim(
      dir,
      [call(1, "noisy", {}), call(2, "echo", { text: "after" })].join("\n") +
        "\n",
    );
    expect(run.status).toBe(0);
    const replies = parseReplies(run.stdout);
    expect(replies.map((r) => r.id)).toEqual([1, 2]);
    expect(replies[0]?.result.content[0].text).toBe("ok");
    expect(replies[1]?.result.content[0].text).toBe('{"text": "after"}');
    expect(run.stdout).not.toContain("stray-child-output");
    expect(run.stderr).toContain("stray-child-output");
    expect(run.stderr).toContain("child print");
  });

  it("speaks UTF-8 even when the locale codec is cp1252", () => {
    const dir = writeHermesPluginSource(join(home, "plugins"), "p", ECHO_PLUGIN);
    const text = "Привет 👋 数据";
    const run = runShim(dir, call(1, "echo", { text }) + "\n", {
      PYTHONUTF8: "0",
      PYTHONIOENCODING: "cp1252",
    });
    expect(run.status).toBe(0);
    const [reply] = parseReplies(run.stdout);
    expect(JSON.parse(reply?.result.content[0].text)).toEqual({ text });
  });

  it("answers a non-UTF-8 line with a parse error and keeps serving", () => {
    const dir = writeHermesPluginSource(join(home, "plugins"), "p", ECHO_PLUGIN);
    const input = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x81, 0x0a]),
      Buffer.from(call(2, "echo", { text: "still alive" }) + "\n"),
    ]);
    const run = runShim(dir, input);
    expect(run.status).toBe(0);
    const replies = parseReplies(run.stdout);
    expect(replies[0]?.error.code).toBe(-32700);
    expect(replies[1]?.id).toBe(2);
    expect(replies[1]?.result.content[0].text).toContain("still alive");
  });

  it("loads only requires_env names from HERMES_HOME/.env", () => {
    const dir = writeHermesPluginSource(
      join(home, "plugins"),
      "weather",
      [
        "import json, os",
        "def env(args, **kw):",
        "    return json.dumps({k: os.environ.get(k) for k in",
        "        ('FAKE_KEY', 'SINGLE', 'OTHER_SECRET')})",
        "def register(ctx):",
        "    ctx.register_tool(name='env', toolset='t', schema={}, handler=env,",
        "        requires_env=['FAKE_KEY', 'SINGLE'])",
        "    ctx.register_tool(name='hidden', toolset='t', schema={},",
        "        handler=env, requires_env=['NOT_IN_DOTENV'])",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(home, ".env"),
      [
        "# Hermes keys",
        'export FAKE_KEY="quoted # not a comment"',
        "SINGLE='single'  ",
        "OTHER_SECRET=must-not-leak # trailing comment",
        "",
      ].join("\n"),
    );
    const env: Record<string, string> = { HERMES_HOME: home };
    const run = spawnSync("python3", [resolvePackagedHermesShim()!, dir], {
      input:
        [
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          call(2, "env", {}),
        ].join("\n") + "\n",
      encoding: "utf8",
      timeout: 20_000,
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...env }).filter(
          ([k]) => !["FAKE_KEY", "SINGLE", "OTHER_SECRET"].includes(k),
        ),
      ) as Record<string, string>,
    });
    expect(run.status).toBe(0);
    const replies = parseReplies(run.stdout);
    expect(
      (replies[0]?.result.tools as { name: string }[]).map((t) => t.name),
    ).toEqual(["env"]);
    expect(JSON.parse(replies[1]?.result.content[0].text)).toEqual({
      FAKE_KEY: "quoted # not a comment",
      SINGLE: "single",
      OTHER_SECRET: null,
    });
    expect(run.stderr).toContain("missing env NOT_IN_DOTENV");
  });
});
