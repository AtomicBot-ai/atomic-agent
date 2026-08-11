import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
});
