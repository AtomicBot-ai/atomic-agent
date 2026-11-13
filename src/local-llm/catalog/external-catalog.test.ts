import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  catalogCompatibility,
  DEFAULT_EXTERNAL_CATALOG_URL,
  EXTERNAL_CATALOG_CACHE_FILENAME,
  EXTERNAL_CATALOG_FILENAME,
  externalCatalogUrl,
  loadExternalCatalog,
  parseExternalCatalog,
  parseExternalEntry,
  refreshExternalCatalog,
} from "./external-catalog.js";
import type { MachineForModels } from "./model-upgrade.js";
import {
  getLocalModelDef,
  listLocalModels,
  LOCAL_MODELS_CATALOG,
  setCustomLocalModels,
  setExternalLocalModels,
} from "./models-catalog.js";

const ENTRY = {
  id: "qwen3-14b-q4",
  name: "Qwen3 14B",
  huggingFaceUrl: "https://huggingface.co/unsloth/Qwen3-14B-GGUF/resolve/main/Qwen3-14B-Q4_K_M.gguf",
  fileSizeGb: 9,
  minRamGb: 11,
  recommendedRamGb: 16,
};

const MAC: MachineForModels = {
  ramGb: 32,
  gpuBudgetGb: 24,
  freeDiskGb: 200,
  cpuOnly: false,
  bandwidth: { gpuGbPerSec: 200, ramGbPerSec: 200, unified: true },
};

describe("parseExternalEntry", () => {
  it("builds a namespaced definition that is never recommended", () => {
    const def = parseExternalEntry(ENTRY, "t");
    expect(typeof def).toBe("object");
    if (typeof def === "string") return;
    expect(def.id).toBe("custom-catalog-qwen3-14b-q4");
    expect(def.filename).toBe("Qwen3-14B-Q4_K_M.gguf");
    expect(def.family).toBe("custom");
    expect(def.recommendRank).toBeUndefined();
    expect(def.localPath).toBeUndefined();
    expect(def.chatTemplateAsset).toBeUndefined();
    expect(def.sizeLabel).toBe("9.0 GB");
  });

  const bad: [string, Record<string, unknown>][] = [
    ["a non-https URL", { huggingFaceUrl: "http://huggingface.co/a/b/resolve/main/m-Q4_K_M.gguf" }],
    ["a URL off Hugging Face", { huggingFaceUrl: "https://example.com/m-Q4_K_M.gguf" }],
    ["a file that is not .gguf", { huggingFaceUrl: "https://huggingface.co/a/b/resolve/main/model.bin" }],
    ["a shard", { huggingFaceUrl: "https://huggingface.co/a/b/resolve/main/m-Q4_K_M-00001-of-00002.gguf" }],
    ["full-precision weights", { huggingFaceUrl: "https://huggingface.co/a/b/resolve/main/m-F16.gguf" }],
    ["an id with a path in it", { id: "../evil" }],
    ["a missing size", { fileSizeGb: undefined }],
    ["min RAM above recommended", { minRamGb: 32, recommendedRamGb: 16 }],
    ["a control character in the name", { name: "Qwen\u001b[2J" }],
  ];
  for (const [what, patch] of bad) {
    it(`drops ${what} with a reason`, () => {
      expect(typeof parseExternalEntry({ ...ENTRY, ...patch }, "t")).toBe("string");
    });
  }

  it("ignores fields that could change how the curated models are chosen", () => {
    const def = parseExternalEntry(
      { ...ENTRY, recommendRank: 0, spotlight: true, localPath: "/etc/passwd.gguf", chatTemplateAsset: "../../x" },
      "t",
    );
    if (typeof def === "string") throw new Error(def);
    expect(def.recommendRank).toBeUndefined();
    expect(def.spotlight).toBeUndefined();
    expect(def.localPath).toBeUndefined();
    expect(def.chatTemplateAsset).toBeUndefined();
  });
});

describe("parseExternalCatalog", () => {
  it("keeps the good entries and says why the others were dropped", () => {
    const out = parseExternalCatalog(
      { version: 1, models: [ENTRY, { ...ENTRY, id: "bad", fileSizeGb: -1 }, ENTRY] },
      "src",
    );
    expect(out.entries.map((e) => e.id)).toEqual(["custom-catalog-qwen3-14b-q4"]);
    expect(out.rejected).toHaveLength(2);
    expect(out.rejected[1]).toContain("duplicate id");
  });

  it("refuses an unknown version", () => {
    expect(parseExternalCatalog({ version: 2, models: [ENTRY] }, "src").entries).toEqual([]);
  });
});

describe("loading and refreshing", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-ext-catalog-"));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("is empty when nothing is there", () => {
    expect(loadExternalCatalog(stateDir)).toEqual({ entries: [], rejected: [] });
  });

  it("merges the operator's file over the URL's cache", () => {
    writeFileSync(join(stateDir, EXTERNAL_CATALOG_FILENAME), JSON.stringify({ version: 1, models: [ENTRY] }));
    writeFileSync(
      join(stateDir, EXTERNAL_CATALOG_CACHE_FILENAME),
      JSON.stringify({ version: 1, models: [{ ...ENTRY, name: "From URL" }, { ...ENTRY, id: "other" }] }),
    );
    const out = loadExternalCatalog(stateDir);
    expect(out.entries.map((e) => [e.id, e.name])).toEqual([
      ["custom-catalog-qwen3-14b-q4", "Qwen3 14B"],
      ["custom-catalog-other", "Qwen3 14B"],
    ]);
  });

  it("reports a broken file instead of throwing", () => {
    writeFileSync(join(stateDir, EXTERNAL_CATALOG_FILENAME), "{nope");
    expect(loadExternalCatalog(stateDir).rejected[0]).toContain("not valid JSON");
  });

  it("caches a good answer and keeps it when the next fetch fails", async () => {
    const good = JSON.stringify({ version: 1, models: [ENTRY] });
    const first = await refreshExternalCatalog({
      url: "https://example.com/catalog.json",
      stateDir,
      fetchImpl: async () => new Response(good, { status: 200 }),
    });
    expect(first.error).toBeNull();
    expect(readFileSync(join(stateDir, EXTERNAL_CATALOG_CACHE_FILENAME), "utf8")).toBe(good);

    const second = await refreshExternalCatalog({
      url: "https://example.com/catalog.json",
      stateDir,
      fetchImpl: async () => new Response("", { status: 503 }),
    });
    expect(second.error).toContain("503");
    expect(second.catalog.entries).toHaveLength(1);
  });

  it("does not overwrite the cache with a catalog that has only bad entries", async () => {
    const out = await refreshExternalCatalog({
      url: "https://example.com/catalog.json",
      stateDir,
      fetchImpl: async () =>
        new Response(JSON.stringify({ version: 1, models: [{ id: "x" }] }), { status: 200 }),
    });
    expect(out.error).not.toBeNull();
    expect(loadExternalCatalog(stateDir).entries).toEqual([]);
  });
});

describe("externalCatalogUrl", () => {
  it("defaults to our own hosted catalog on atomicagent.io", () => {
    expect(DEFAULT_EXTERNAL_CATALOG_URL).toBe("https://atomicagent.io/models-catalog.json");
    expect(externalCatalogUrl({})).toBe(DEFAULT_EXTERNAL_CATALOG_URL);
    expect(externalCatalogUrl({ ATOMIC_AGENT_MODEL_CATALOG_URL: "  " })).toBe(DEFAULT_EXTERNAL_CATALOG_URL);
  });

  it("lets the env var override it, https only", () => {
    expect(externalCatalogUrl({ ATOMIC_AGENT_MODEL_CATALOG_URL: "https://x.test/c.json" })).toBe(
      "https://x.test/c.json",
    );
    expect(externalCatalogUrl({ ATOMIC_AGENT_MODEL_CATALOG_URL: "http://x.test/c.json" })).toBeNull();
  });
});

describe("the default catalog before the site hosts it", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ext-catalog-default-"));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("is silent on a 404 and leaves the list as it was", async () => {
    let asked = "";
    const out = await refreshExternalCatalog({
      url: DEFAULT_EXTERNAL_CATALOG_URL,
      stateDir,
      fetchImpl: async (url) => {
        asked = String(url);
        return new Response("Not Found", { status: 404 });
      },
    });
    expect(asked).toBe(DEFAULT_EXTERNAL_CATALOG_URL);
    expect(out.error).toBeNull();
    expect(out.notPublished).toBe(true);
    expect(out.catalog).toEqual({ entries: [], rejected: [] });
    expect(loadExternalCatalog(stateDir)).toEqual({ entries: [], rejected: [] });
  });

  it("still reports a 404 from a URL the operator named", async () => {
    const out = await refreshExternalCatalog({
      url: "https://example.com/catalog.json",
      stateDir,
      fetchImpl: async () => new Response("", { status: 404 }),
    });
    expect(out.error).toContain("404");
    expect(out.notPublished).toBeUndefined();
  });
});

describe("catalogCompatibility", () => {
  const def = parseExternalEntry(ENTRY, "t");
  if (typeof def === "string") throw new Error(def);

  it("fits a machine with room to spare, with a labelled speed estimate", () => {
    const c = catalogCompatibility(def, MAC);
    expect(c.fit.label).toBe("Fits well");
    expect(c.speed?.label).toMatch(/estimate$/);
  });

  it("calls a model whose own minimum is above the RAM too big", () => {
    expect(catalogCompatibility(def, { ...MAC, ramGb: 8, gpuBudgetGb: 6 }).fit.tier).toBe("too-big");
  });

  it("is a tight fit when the entry wants more GPU memory than there is", () => {
    const pc: MachineForModels = { ...MAC, gpuBudgetGb: 12, bandwidth: undefined };
    expect(catalogCompatibility({ ...def, vramGb: 14 }, pc).fit.tier).toBe("tight");
  });
});

describe("the catalog registry", () => {
  afterEach(() => {
    setExternalLocalModels([]);
    setCustomLocalModels([]);
  });

  it("lists external rows after the curated ones and resolves their ids", () => {
    const def = parseExternalEntry(ENTRY, "t");
    if (typeof def === "string") throw new Error(def);
    setExternalLocalModels([def]);
    expect(listLocalModels()).toHaveLength(LOCAL_MODELS_CATALOG.length + 1);
    expect(getLocalModelDef(def.id).name).toBe("Qwen3 14B");
  });

  it("lets a model the operator added keep its own definition", () => {
    const def = parseExternalEntry(ENTRY, "t");
    if (typeof def === "string") throw new Error(def);
    setExternalLocalModels([def]);
    setCustomLocalModels([{ ...def, name: "Mine" }]);
    expect(listLocalModels().filter((m) => m.id === def.id).map((m) => m.name)).toEqual(["Mine"]);
  });
});
