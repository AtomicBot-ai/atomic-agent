import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getUserConfigPath, writeUserConfigFileSync } from "../config/config-file.js";
import { resetConfigCache, getConfig } from "../config/index.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";

import { modelsCommand } from "./models-command.js";

describe("modelsCommand", () => {
  let stateDir: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-models-cli-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    stdoutChunks = [];
    stderrChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  function stdout(): string {
    return stdoutChunks.join("");
  }

  it("prints help", async () => {
    const code = await modelsCommand([]);
    expect(code).toBe(0);
    expect(stdout()).toMatch(/atomic-agent models/);
    expect(stdout()).toMatch(/models list/);
  });

  it("list prints 8 model rows", async () => {
    const code = await modelsCommand(["list"]);
    expect(code).toBe(0);
    const out = stdout();
    expect(out.split("\n").filter((l) => l.includes("qwen-") || l.includes("gemma-"))).toHaveLength(
      8,
    );
  });

  it("pull with bad id exits 1", async () => {
    const code = await modelsCommand(["pull", "nope"]);
    expect(code).toBe(1);
  });

  it("stop without pid prints stopped", async () => {
    const code = await modelsCommand(["stop"]);
    expect(code).toBe(0);
    expect(stdout()).toMatch(/stopped/);
  });

  it("use persists managed model in config", async () => {
    const path = getUserConfigPath(stateDir);
    writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
    resetConfigCache();
    const code = await modelsCommand(["use", "qwen-3.5-4b"]);
    expect(code).toBe(0);
    resetConfigCache();
    const cfg = getConfig();
    expect(cfg.localModels.mode).toBe("managed");
    expect(cfg.localModels.managed.modelId).toBe("qwen-3.5-4b");
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      localModels: { mode: string };
    };
    expect(raw.localModels.mode).toBe("managed");
  });
});
