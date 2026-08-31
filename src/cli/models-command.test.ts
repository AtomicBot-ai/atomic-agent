import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getUserConfigPath, writeUserConfigFileSync } from "../config/config-file.js";
import { resetConfigCache, getConfig } from "../config/index.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";

import type { LocalModelDef } from "../local-llm/index.js";

import { modelsCommand } from "./models-command.js";

/**
 * A complete def (not the four-line hand-written shape) because
 * `writeUserConfigFileSync` takes the parsed type; the values mirror
 * what `buildCustomModelDef` mints from a real repo.
 */
const CUSTOM_DEF: LocalModelDef = {
  id: "custom-unsloth-qwen3-0.6b-gguf-qwen3-0.6b-ud-q4_k_xl",
  name: "unsloth/Qwen3-0.6B-GGUF · Qwen3-0.6B-UD-Q4_K_XL.gguf",
  filename: "Qwen3-0.6B-UD-Q4_K_XL.gguf",
  huggingFaceUrl:
    "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-UD-Q4_K_XL.gguf",
  fileSizeGb: 0.37,
  sizeLabel: "378 MB",
  description: "Added from huggingface.co/unsloth/Qwen3-0.6B-GGUF",
  maxContextLength: 0,
  contextLabel: "auto",
  minRamGb: 1,
  recommendedRamGb: 3,
  family: "custom",
  supportsVision: false,
};

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

  it("list prints all catalog model rows", async () => {
    const code = await modelsCommand(["list"]);
    expect(code).toBe(0);
    const out = stdout();
    // One row per curated model in LOCAL_MODELS_CATALOG.
    expect(
      out
        .split("\n")
        .filter(
          (l) =>
            l.includes("qwen-") ||
            l.includes("gemma-") ||
            l.includes("nemotron-") ||
            l.includes("muse-"),
        ),
    ).toHaveLength(13);
  });

  describe("models the operator added from Hugging Face", () => {
    function seedCustomModel(): void {
      writeUserConfigFileSync(getUserConfigPath(stateDir), {
        ...USER_CONFIG_DEFAULTS,
        localModels: {
          ...USER_CONFIG_DEFAULTS.localModels,
          mode: "managed",
          customModels: [CUSTOM_DEF],
          managed: {
            ...USER_CONFIG_DEFAULTS.localModels.managed,
            modelId: CUSTOM_DEF.id,
          },
        },
      });
      resetConfigCache();
    }

    it("list shows the added model on the same list, marked active", async () => {
      seedCustomModel();
      const code = await modelsCommand(["list"]);
      expect(code).toBe(0);
      const row = stdout()
        .split("\n")
        .find((l) => l.includes(CUSTOM_DEF.id));
      expect(row).toBeDefined();
      expect(row).toContain("custom");
      expect(row?.trimEnd().endsWith("*")).toBe(true);
    });

    it("names the added model among the valid ids on a typo", async () => {
      seedCustomModel();
      const code = await modelsCommand(["pull", "nope"]);
      expect(code).toBe(1);
      expect(stderrChunks.join("")).toContain(CUSTOM_DEF.id);
    });

    // Deleting a custom model undoes the add: unlike a curated row the
    // entry has no life outside the operator's config, and a row that
    // cannot be dropped would haunt `models list` forever.
    it("remove drops the files, the row and the active mark", async () => {
      seedCustomModel();
      const code = await modelsCommand(["remove", CUSTOM_DEF.id]);
      expect(code).toBe(0);
      const raw = JSON.parse(
        readFileSync(getUserConfigPath(stateDir), "utf8"),
      ) as {
        localModels: {
          customModels: unknown[];
          managed: { modelId: string | null };
        };
      };
      expect(raw.localModels.customModels).toEqual([]);
      expect(raw.localModels.managed.modelId).toBeNull();
      stdoutChunks.length = 0;
      resetConfigCache();
      expect(await modelsCommand(["list"])).toBe(0);
      expect(stdout()).not.toContain(CUSTOM_DEF.id);
    });
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

  it("devices exits 1 when the backend is not downloaded", async () => {
    const code = await modelsCommand(["devices"]);
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toMatch(/backend not downloaded/);
  });

  it("use-device with no arg exits 1", async () => {
    const code = await modelsCommand(["use-device"]);
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toMatch(/usage:/);
  });

  it("use-device rejects an invalid device value", async () => {
    const code = await modelsCommand(["use-device", "not a device"]);
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toMatch(/invalid device/);
  });

  it("use-device persists the device preference in config", async () => {
    const path = getUserConfigPath(stateDir);
    writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
    resetConfigCache();
    const code = await modelsCommand(["use-device", "Vulkan0"]);
    expect(code).toBe(0);
    resetConfigCache();
    expect(getConfig().localModels.managed.device).toBe("Vulkan0");
  });

  it("use-device accepts the cpu sentinel", async () => {
    const path = getUserConfigPath(stateDir);
    writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
    resetConfigCache();
    const code = await modelsCommand(["use-device", "cpu"]);
    expect(code).toBe(0);
    resetConfigCache();
    expect(getConfig().localModels.managed.device).toBe("cpu");
  });
});
