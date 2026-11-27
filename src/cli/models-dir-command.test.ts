import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfig, resetConfigCache } from "../config/index.js";
import { setModelsDirOverride } from "../local-llm/models-dir-override.js";

import { MODELS_DIR_KEY, runModelsDir } from "./models-dir-command.js";

describe("models dir (ATO-2106)", () => {
  let stateDir: string;
  let out: string[];
  let err: string[];
  const deps = () => ({
    write: (t: string) => void out.push(t),
    writeErr: (t: string) => void err.push(t),
    busyReason: async () => null,
  });
  const configTree = () =>
    JSON.parse(readFileSync(getConfig().paths.userConfigFile, "utf8")) as {
      localModels?: { managed?: Record<string, unknown> };
    };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-models-dir-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    out = [];
    err = [];
    const model = join(getConfig().paths.localModelsDataDir, "models", "qwen-3.5-4b");
    mkdirSync(model, { recursive: true });
    writeFileSync(join(model, "q.gguf"), "weights");
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    setModelsDirOverride(null);
    resetConfigCache();
  });

  it("prints the default folder when nothing was moved", async () => {
    expect(await runModelsDir(["--json"], deps())).toBe(0);
    const info = JSON.parse(out.join("")) as { dir: string; custom: boolean };
    expect(info.custom).toBe(false);
    expect(info.dir).toBe(join(getConfig().paths.localModelsDataDir, "models"));
  });

  it("moves the models, saves the folder, and moves them back on --reset", async () => {
    const external = join(stateDir, "external-disk", "my models");
    expect(await runModelsDir([external], deps())).toBe(0);
    expect(readFileSync(join(external, "qwen-3.5-4b", "q.gguf"), "utf8")).toBe("weights");
    expect(configTree().localModels?.managed?.modelsDirOverride).toBe(external);
    expect(out.join("")).toContain(`models folder: ${external}`);

    out = [];
    expect(await runModelsDir([], deps())).toBe(0);
    expect(out.join("").trim()).toBe(external);

    out = [];
    expect(await runModelsDir(["--reset"], deps())).toBe(0);
    const defaultDir = join(getConfig().paths.localModelsDataDir, "models");
    expect(existsSync(join(defaultDir, "qwen-3.5-4b", "q.gguf"))).toBe(true);
    expect(existsSync(join(external, "qwen-3.5-4b"))).toBe(false);
    expect(configTree().localModels?.managed?.[MODELS_DIR_KEY.split(".").pop()!]).toBeUndefined();
  });

  it("refuses while a model runs or a download goes, and touches nothing", async () => {
    const external = join(stateDir, "external-disk");
    const code = await runModelsDir([external], { ...deps(), busyReason: async () => "a local model is running" });
    expect(code).toBe(1);
    expect(err.join("")).toContain("a local model is running");
    expect(existsSync(join(external, "qwen-3.5-4b"))).toBe(false);
    expect(existsSync(getConfig().paths.userConfigFile) ? configTree().localModels?.managed?.modelsDirOverride : undefined).toBeUndefined();
  });

  it("refuses a folder inside the current one without saving it", async () => {
    const inside = join(getConfig().paths.localModelsDataDir, "models", "nested");
    expect(await runModelsDir([inside], deps())).toBe(1);
    expect(err.join("")).toContain("inside the current models folder");
    expect(existsSync(getConfig().paths.userConfigFile) ? configTree().localModels?.managed?.modelsDirOverride : undefined).toBeUndefined();
  });

  it("rejects a folder and --reset together", async () => {
    expect(await runModelsDir(["/x", "--reset"], deps())).toBe(2);
  });
});
