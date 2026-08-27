import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configCommand } from "./config-command.js";
import {
  parseUserConfigFile,
  resetConfigCache,
  USER_CONFIG_VERSION,
} from "../config/index.js";

describe("configCommand", () => {
  let stateDir: string;
  let stdout = "";
  let stderr = "";

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-cli-config-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    stdout = "";
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it("get prints the whole file as JSON", async () => {
    const code = await configCommand(["get"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.localModels.url).toBe("http://127.0.0.1:8080");
    expect(parsed.agent.maxSteps).toBe(25);
  });

  it("set replaces the whole file with a validated JSON payload", async () => {
    const payload = {
      version: USER_CONFIG_VERSION,
      localModels: { url: "http://10.0.0.5:18991" },
      log: { level: "debug" },
      agent: {
        tokenBudget: 3000,
        maxSteps: 42,
        toolTimeoutMs: 12_000,
        approvalLevel: 5,
        conversationMaxTokens: 32_000,
        worldSnapshotMaxTokens: 8_000,
      },
      http: {
        enabled: true,
        approvalMode: "writes" as const,
        hostAllowlist: null,
        maxResponseBytes: 1_048_576,
        defaultTimeoutMs: 30_000,
      },
      tracing: {
        trace: {
          enabled: null,
          maxBytesPerSession: 10 * 1024 * 1024,
        },
      },
      memory: {
        profile: { enabled: true, maxTokens: 512 },
        reflection: { enabled: true, timeoutMs: 10_000, maxFactsPerCall: 3 },
        notes: {
          enabled: true,
          maxEntries: 1_000,
          maxContentChars: 4_000,
          recallDefaultK: 5,
        },
      },
    };
    const code = await configCommand(["set", JSON.stringify(payload)]);
    expect(code).toBe(0);
    const onDisk = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"));
    expect(onDisk).toEqual(parseUserConfigFile(payload));
    expect(stdout).toContain("wrote ");
  });

  it("set rejects malformed JSON without touching the file", async () => {
    await configCommand(["get"]);
    const before = readFileSync(join(stateDir, "config.json"), "utf8");
    const code = await configCommand(["set", "{not json"]);
    expect(code).toBe(1);
    expect(stderr).toContain("invalid JSON");
    const after = readFileSync(join(stateDir, "config.json"), "utf8");
    expect(after).toBe(before);
  });

  it("set rejects a payload that fails schema validation", async () => {
    await configCommand(["get"]);
    const before = readFileSync(join(stateDir, "config.json"), "utf8");
    const code = await configCommand([
      "set",
      JSON.stringify({
        version: USER_CONFIG_VERSION,
        localModels: { url: "nope" },
        log: { level: "info" },
        agent: {
          tokenBudget: 3000,
          maxSteps: 25,
          toolTimeoutMs: 60_000,
          approvalRequired: true,
        },
      }),
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("localModels.url");
    const after = readFileSync(join(stateDir, "config.json"), "utf8");
    expect(after).toBe(before);
  });

  it("set accepts a JSON argument split by the shell across multiple args", async () => {
    const code = await configCommand([
      "set",
      "{",
      `"version":${USER_CONFIG_VERSION},`,
      '"localModels":{"url":"http://x:1"}',
      "}",
    ]);
    expect(code).toBe(0);
    const onDisk = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"));
    expect(onDisk.localModels.url).toBe("http://x:1");
  });

  it("set without a payload prints usage and returns non-zero", async () => {
    const code = await configCommand(["set"]);
    expect(code).toBe(1);
    expect(stderr).toContain("usage: atomic-agent config set");
  });

  it("help prints subcommand summary", async () => {
    const code = await configCommand(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("get");
    expect(stdout).toContain("set");
  });

  it("unknown subcommands return non-zero", async () => {
    const code = await configCommand(["wat"]);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown subcommand: wat");
  });

  it("the set example in --help runs through the real set path", async () => {
    // Rot-proofing: extract the example payload straight out of the rendered
    // help text and feed it to `config set` for real. If the schema moves and
    // the example is left behind (as happened with `"version":1` + `llama`),
    // this test fails instead of a user's paste.
    await configCommand(["--help"]);
    const match = stdout.match(/config set '(\{.*\})'/);
    expect(match).not.toBeNull();
    stdout = "";
    const code = await configCommand(["set", match![1]]);
    expect(code).toBe(0);
    const onDisk = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"));
    expect(onDisk.version).toBe(USER_CONFIG_VERSION);
    expect(onDisk.localModels.url).toBe("http://127.0.0.1:19091");
  });

  describe("point edits", () => {
    /** Seed a hand-written sparse config, as a user who edited the file would have. */
    function seedSparseConfig(tree: Record<string, unknown>): void {
      writeFileSync(
        join(stateDir, "config.json"),
        JSON.stringify({ version: USER_CONFIG_VERSION, ...tree }, null, 2),
      );
      resetConfigCache();
    }

    it("set <key> <value> writes one key and leaves the rest of the file alone", async () => {
      seedSparseConfig({ agent: { maxSteps: 7 } });
      const code = await configCommand(["set", "log.level", "debug"]);
      expect(code).toBe(0);
      const onDisk = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"));
      expect(onDisk.log.level).toBe("debug");
      // The pre-existing user value survives untouched...
      expect(onDisk.agent.maxSteps).toBe(7);
      // ...and the file is NOT expanded with every default in the schema.
      // Writing back the defaulted parse output would freeze today's
      // defaults into the user's file; only touched keys may appear.
      expect(Object.keys(onDisk).sort()).toEqual(["agent", "log", "version"]);
      expect(stdout.trim()).toBe('log.level = "debug"');
    });

    it("set coerces the raw string through the schema rather than guessing types", async () => {
      // The command never inspects the value: "false" becomes a boolean and
      // "19099" a number purely because the schema's parsers coerce them.
      // This is what keeps CLI typing from drifting from the schema.
      expect(await configCommand(["set", "localModels.managed.autoUpdate", "false"])).toBe(0);
      expect(await configCommand(["set", "localModels.managed.port", "19099"])).toBe(0);
      const onDisk = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"));
      expect(onDisk.localModels.managed.autoUpdate).toBe(false);
      expect(onDisk.localModels.managed.port).toBe(19099);
    });

    it("set rejects an unknown key instead of silently writing nothing", async () => {
      // The load-bearing test. `parseUserConfigFile` IGNORES unknown keys,
      // so without our own check this typo would validate, write a file
      // with no such setting, and report success — the command would lie.
      seedSparseConfig({ agent: { maxSteps: 7 } });
      const before = readFileSync(join(stateDir, "config.json"), "utf8");
      const code = await configCommand([
        "set",
        "localModels.managed.autoUpdte",
        "false",
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain("unknown key localModels.managed.autoUpdte");
      expect(stderr).toContain("did you mean localModels.managed.autoUpdate?");
      expect(readFileSync(join(stateDir, "config.json"), "utf8")).toBe(before);
    });

    it("set suggests nothing when no key is close enough", async () => {
      // A wrong suggestion points the user at a real but unintended
      // setting, so the threshold stays conservative.
      const code = await configCommand(["set", "totally.bogus.nonsense", "1"]);
      expect(code).toBe(1);
      expect(stderr).toContain("unknown key");
      expect(stderr).not.toContain("did you mean");
    });

    it("set rejects a value the schema refuses, leaving the file untouched", async () => {
      seedSparseConfig({ agent: { maxSteps: 7 } });
      const before = readFileSync(join(stateDir, "config.json"), "utf8");
      const code = await configCommand(["set", "agent.maxSteps", "0"]);
      expect(code).toBe(1);
      // The dotted path comes from ConfigValidationError, not from us.
      expect(stderr).toContain("agent.maxSteps");
      expect(readFileSync(join(stateDir, "config.json"), "utf8")).toBe(before);
    });

    it("set rejects a partly-numeric value instead of truncating it", async () => {
      // `Number.parseInt` stops at the first character it cannot read, which
      // would turn each of these into a plausible-looking number and write it
      // as a success. `1e3` is the worst case: asking for 1000 and silently
      // getting a token budget of 1.
      for (const bad of ["1e3", "100_000", "60s", "1,000", "10.9", "8080x"]) {
        seedSparseConfig({ agent: { maxSteps: 7 } });
        const before = readFileSync(join(stateDir, "config.json"), "utf8");
        stderr = "";
        const code = await configCommand(["set", "agent.tokenBudget", bad]);
        expect(code, `${bad} should be rejected`).toBe(1);
        expect(stderr).toContain("agent.tokenBudget");
        expect(readFileSync(join(stateDir, "config.json"), "utf8")).toBe(
          before,
        );
      }
    });

    it("set still accepts a clean integer, with surrounding space", async () => {
      seedSparseConfig({ agent: { maxSteps: 7 } });
      const code = await configCommand(["set", "agent.tokenBudget", " 1000 "]);
      expect(code).toBe(0);
      expect(stdout).toContain("agent.tokenBudget = 1000");
    });

    it("set rejects a partly-numeric fractional value", async () => {
      seedSparseConfig({ agent: { maxSteps: 7 } });
      const code = await configCommand([
        "set",
        "memory.retrieve.fts5Threshold",
        "0.85xyz",
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain("fts5Threshold");
    });

    it("set rejects version, which the schema's migration owns", async () => {
      const code = await configCommand(["set", "version", "12"]);
      expect(code).toBe(1);
      expect(stderr).toContain("managed by the config schema");
    });

    it("set rejects a branch and a list rather than inventing syntax", async () => {
      expect(await configCommand(["set", "localModels.managed", "x"])).toBe(1);
      expect(stderr).toContain("unknown key localModels.managed");
      stderr = "";
      expect(await configCommand(["set", "projects.roots", "/a"])).toBe(1);
      expect(stderr).toContain("is a list");
    });

    it("set with a key but no value is a usage error, not a get", async () => {
      const code = await configCommand(["set", "agent.maxSteps"]);
      expect(code).toBe(1);
      expect(stderr).toContain("no value given for agent.maxSteps");
    });

    it("unset restores a key to its default and prunes the emptied block", async () => {
      seedSparseConfig({ agent: { maxSteps: 7 } });
      const code = await configCommand(["unset", "agent.maxSteps"]);
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("agent.maxSteps \u2192 25 (default)");
      const onDisk = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"));
      // The now-empty `agent` block is pruned rather than left as a husk.
      expect(onDisk.agent).toBeUndefined();
    });

    it("unset works on list keys, which set refuses", async () => {
      seedSparseConfig({ projects: { roots: ["/tmp/x"] } });
      expect(await configCommand(["unset", "projects.roots"])).toBe(0);
      const onDisk = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"));
      expect(onDisk.projects).toBeUndefined();
    });

    it("unset rejects an unknown key", async () => {
      expect(await configCommand(["unset", "agent.maxStep"])).toBe(1);
      expect(stderr).toContain("unknown key agent.maxStep");
    });

    it("get <key> prints a single value and rejects unknown keys", async () => {
      seedSparseConfig({ agent: { maxSteps: 7 } });
      expect(await configCommand(["get", "agent.maxSteps"])).toBe(0);
      expect(stdout.trim()).toBe("7");
      stdout = "";
      expect(await configCommand(["get", "localModels.managed"])).toBe(0);
      expect(JSON.parse(stdout).port).toBe(19091);
      stdout = "";
      expect(await configCommand(["get", "nope.nope"])).toBe(1);
      expect(stderr).toContain("unknown key nope.nope");
    });

    it("list marks non-default values and masks credential-shaped strings", async () => {
      seedSparseConfig({ agent: { maxSteps: 42 } });
      const code = await configCommand(["list"]);
      expect(code).toBe(0);
      const lines = stdout.split("\n");
      const maxSteps = lines.find((line) => line.startsWith("agent.maxSteps "));
      expect(maxSteps).toContain("= 42");
      expect(maxSteps).toContain("(default 25)");
      // A key left at its default carries no annotation.
      expect(lines.find((line) => line.startsWith("log.level "))).not.toContain(
        "(default",
      );
      // `apiKeyEnv` holds an env var name today, but anything
      // credential-shaped is masked before it reaches a terminal.
      expect(
        lines.find((line) => line.startsWith("web.search.exa.apiKeyEnv ")),
      ).toContain("***");
      // A token *count* is not a credential and must stay readable.
      expect(
        lines.find((line) => line.startsWith("agent.tokenBudget ")),
      ).toContain("= 3000");
    });

    it("path prints the config file location", async () => {
      expect(await configCommand(["path"])).toBe(0);
      expect(stdout.trim()).toBe(join(stateDir, "config.json"));
    });

    it("the key/value example in --help runs through the real set path", async () => {
      // Same rot-proofing as the JSON example above: the documented
      // `<key> <value>` line is executed, so a renamed key fails here
      // rather than in a user's terminal.
      await configCommand(["--help"]);
      const match = stdout.match(/config set ([a-zA-Z.]+) (\S+)\n/);
      expect(match).not.toBeNull();
      stdout = "";
      const code = await configCommand(["set", match![1], match![2]]);
      expect(code).toBe(0);
      expect(stdout.trim()).toBe(`${match![1]} = ${match![2]}`);
    });
  });
});
