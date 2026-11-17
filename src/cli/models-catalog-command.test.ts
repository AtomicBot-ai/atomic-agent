import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "../config/index.js";
import {
  DEFAULT_EXTERNAL_CATALOG_URL,
  EXTERNAL_CATALOG_FILENAME,
} from "../local-llm/catalog/external-catalog.js";
import { setExternalLocalModels } from "../local-llm/catalog/models-catalog.js";

import { runModelsCatalog } from "./models-catalog-command.js";

const ENTRY = {
  id: "qwen3-14b-q4",
  name: "Qwen3 14B",
  huggingFaceUrl: "https://huggingface.co/unsloth/Qwen3-14B-GGUF/resolve/main/Qwen3-14B-Q4_K_M.gguf",
  fileSizeGb: 9,
  minRamGb: 11,
  recommendedRamGb: 16,
};

const machine = async () => ({
  ramGb: 32,
  gpuBudgetGb: 24,
  freeDiskGb: 200,
  cpuOnly: false,
  bandwidth: { gpuGbPerSec: 200, ramGbPerSec: 200, unified: true },
});

describe("models catalog (ATO-27)", () => {
  let stateDir: string;
  let out: string[];
  const write = (text: string) => void out.push(text);

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-models-catalog-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    out = [];
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    setExternalLocalModels([]);
    resetConfigCache();
  });

  it("says how to add a catalog when there is none", async () => {
    expect(await runModelsCatalog([], { probe: machine, write })).toBe(0);
    expect(out.join("")).toContain(EXTERNAL_CATALOG_FILENAME);
  });

  it("lists each entry with its fit and a speed estimate, and the skipped ones", async () => {
    writeFileSync(
      join(stateDir, EXTERNAL_CATALOG_FILENAME),
      JSON.stringify({ version: 1, models: [ENTRY, { id: "broken" }] }),
    );
    expect(await runModelsCatalog([], { probe: machine, write })).toBe(0);
    const text = out.join("");
    expect(text).toContain("custom-catalog-qwen3-14b-q4");
    expect(text).toContain("Fits well");
    expect(text).toContain("tok/s, estimate");
    expect(text).toContain("skipped:");
  });

  it("prints JSON with the compatibility mark", async () => {
    writeFileSync(join(stateDir, EXTERNAL_CATALOG_FILENAME), JSON.stringify({ version: 1, models: [ENTRY] }));
    await runModelsCatalog(["--json"], { probe: machine, write });
    const body = JSON.parse(out.join("")) as { models: { id: string; fit: string }[] };
    expect(body.models).toEqual([expect.objectContaining({ id: "custom-catalog-qwen3-14b-q4", fit: "fits" })]);
  });

  it("refuses --refresh when the override is not https", async () => {
    const env = { ATOMIC_AGENT_MODEL_CATALOG_URL: "http://catalog.test/models.json" };
    expect(await runModelsCatalog(["--refresh"], { probe: machine, write, env })).toBe(1);
    expect(out.join("")).toContain("ATOMIC_AGENT_MODEL_CATALOG_URL");
  });

  it("refreshes from our own catalog when no URL is set, and says nothing while it is not hosted", async () => {
    let asked = "";
    const code = await runModelsCatalog(["--refresh"], {
      probe: machine,
      write,
      env: {},
      refresh: async ({ url }) => {
        asked = url;
        return { catalog: { entries: [], rejected: [] }, error: null, notPublished: true };
      },
    });
    expect(code).toBe(0);
    expect(asked).toBe(DEFAULT_EXTERNAL_CATALOG_URL);
    expect(out.join("")).not.toContain("refresh failed");
    expect(out.join("")).not.toContain("skipped:");
  });

  it("refreshes from the opted-in URL", async () => {
    let asked = "";
    const code = await runModelsCatalog(["--refresh"], {
      probe: machine,
      write,
      env: { ATOMIC_AGENT_MODEL_CATALOG_URL: "https://catalog.test/models.json" },
      refresh: async ({ url, stateDir: dir }) => {
        asked = url;
        writeFileSync(join(dir, "models-catalog.cache.json"), JSON.stringify({ version: 1, models: [ENTRY] }));
        return { catalog: { entries: [], rejected: [] }, error: null };
      },
    });
    expect(code).toBe(0);
    expect(asked).toBe("https://catalog.test/models.json");
    expect(out.join("")).toContain("custom-catalog-qwen3-14b-q4");
  });
});
