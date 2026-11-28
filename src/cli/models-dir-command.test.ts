import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfig, resetConfigCache, USER_CONFIG_VERSION } from "../config/index.js";
import { setModelsDirOverride } from "../local-llm/models-dir-override.js";
import { acquireModelsDirMoveLock, modelsDirMoveLockPath } from "../local-llm/models-dir-move-lock.js";

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

  it("refuses a folder that is not empty and saves nothing", async () => {
    const docs = join(stateDir, "Documents");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "letter.txt"), "dear");
    expect(await runModelsDir([docs], deps())).toBe(1);
    expect(err.join("")).toContain("is not empty");
    expect(existsSync(join(docs, "qwen-3.5-4b"))).toBe(false);
    expect(readFileSync(join(docs, "letter.txt"), "utf8")).toBe("dear");
    expect(existsSync(getConfig().paths.userConfigFile) ? configTree().localModels?.managed?.modelsDirOverride : undefined).toBeUndefined();
  });

  it("holds the move marker during the busy check and releases it after (ATO-2503)", async () => {
    const external = join(stateDir, "external-disk");
    const dataDir = getConfig().paths.localModelsDataDir;
    let heldDuringCheck = false;
    const code = await runModelsDir([external], {
      ...deps(),
      busyReason: async () => {
        heldDuringCheck = existsSync(modelsDirMoveLockPath(dataDir));
        return null;
      },
    });
    expect(code).toBe(0);
    expect(heldDuringCheck).toBe(true);
    expect(existsSync(modelsDirMoveLockPath(dataDir))).toBe(false);
  });

  it("refuses a second move while another one holds the marker (ATO-2503)", async () => {
    const release = acquireModelsDirMoveLock(getConfig().paths.localModelsDataDir);
    try {
      expect(await runModelsDir([join(stateDir, "external-disk")], deps())).toBe(1);
      expect(err.join("")).toContain("already being moved");
      expect(existsSync(join(stateDir, "external-disk", "qwen-3.5-4b"))).toBe(false);
    } finally {
      release();
    }
  });

  it("a stopped move puts every model back and saves nothing (ATO-2503)", async () => {
    const external = join(stateDir, "external-disk");
    const controller = new AbortController();
    controller.abort();
    expect(await runModelsDir([external], { ...deps(), signal: controller.signal })).toBe(1);
    expect(err.join("")).toContain("the move was stopped");
    expect(readFileSync(join(getConfig().paths.localModelsDataDir, "models", "qwen-3.5-4b", "q.gguf"), "utf8")).toBe("weights");
    expect(existsSync(getConfig().paths.userConfigFile) ? configTree().localModels?.managed?.modelsDirOverride : undefined).toBeUndefined();
  });

  it("--stop-on-stdin: a \"stop\" line stops the move and puts every model back (ATO-2503)", async () => {
    const external = join(stateDir, "external-disk");
    const input = new PassThrough();
    const code = await runModelsDir([external, "--stop-on-stdin"], {
      ...deps(),
      stopInput: input,
      busyReason: async () => {
        input.write("stop\n");
        await new Promise((r) => setTimeout(r, 20));
        return null;
      },
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("the move was stopped");
    expect(readFileSync(join(getConfig().paths.localModelsDataDir, "models", "qwen-3.5-4b", "q.gguf"), "utf8")).toBe("weights");
    expect(existsSync(join(external, "qwen-3.5-4b"))).toBe(false);
    expect(existsSync(getConfig().paths.userConfigFile) ? configTree().localModels?.managed?.modelsDirOverride : undefined).toBeUndefined();
  });

  it("--stop-on-stdin: stdin closing (the app quit) stops the move too (ATO-2503)", async () => {
    const external = join(stateDir, "external-disk");
    const input = new PassThrough();
    const code = await runModelsDir([external, "--stop-on-stdin"], {
      ...deps(),
      stopInput: input,
      busyReason: async () => {
        input.end();
        await new Promise((r) => setTimeout(r, 20));
        return null;
      },
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("the move was stopped");
  });

  it("without --stop-on-stdin a \"stop\" line is ignored", async () => {
    const external = join(stateDir, "external-disk");
    const input = new PassThrough();
    input.write("stop\n");
    expect(await runModelsDir([external], { ...deps(), stopInput: input })).toBe(0);
    expect(existsSync(join(external, "qwen-3.5-4b", "q.gguf"))).toBe(true);
  });

  describe("a models folder whose disk is not connected (ATO-2503)", () => {
    let unplugged: string;
    beforeEach(() => {
      unplugged = join(stateDir, "Volumes", "USB", "models");
      writeFileSync(
        getConfig().paths.userConfigFile,
        JSON.stringify({ version: USER_CONFIG_VERSION, localModels: { managed: { modelsDirOverride: unplugged } } }),
      );
      resetConfigCache();
    });

    it("says so in --json (reachable: false) and on stderr", async () => {
      expect(await runModelsDir(["--json"], deps())).toBe(0);
      const info = JSON.parse(out.join("")) as { dir: string; reachable: boolean; custom: boolean };
      expect(info).toMatchObject({ dir: unplugged, reachable: false, custom: true });
      out = [];
      expect(await runModelsDir([], deps())).toBe(0);
      expect(err.join("")).toContain("is its disk connected?");
    });

    it("refuses to move from it", async () => {
      expect(await runModelsDir([join(stateDir, "elsewhere")], deps())).toBe(1);
      expect(err.join("")).toContain("is its disk connected?");
      expect(configTree().localModels?.managed?.modelsDirOverride).toBe(unplugged);
    });

    it("--reset only points back at the default folder", async () => {
      expect(await runModelsDir(["--reset"], deps())).toBe(0);
      expect(out.join("")).toContain(`the models on ${unplugged} stay there`);
      expect(configTree().localModels?.managed?.modelsDirOverride).toBeUndefined();
    });
  });

  it("--json says custom from the same fresh read as dir, not the cached config (ATO-2503)", async () => {
    getConfig();
    const moved = join(stateDir, "Volumes", "USB", "models");
    mkdirSync(moved, { recursive: true });
    const file = getConfig().paths.userConfigFile;
    // Another process (the desktop) moved the folder; this one never reset its config cache.
    writeFileSync(file, JSON.stringify({ version: USER_CONFIG_VERSION, localModels: { managed: { modelsDirOverride: moved } } }));
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    expect(await runModelsDir(["--json"], deps())).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ dir: moved, custom: true });
  });

  it("rejects a folder and --reset together", async () => {
    expect(await runModelsDir(["/x", "--reset"], deps())).toBe(2);
  });
});
