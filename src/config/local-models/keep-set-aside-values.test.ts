import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readUserConfigFileSync, writeUserConfigFileSync } from "../config-file.js";
import { setConfigNoticeSink } from "../config-primitives.js";
import { USER_CONFIG_DEFAULTS, USER_CONFIG_VERSION } from "../config-schema.js";

/* ATO-1239: a whole-file write by this build keeps what a newer build chose and this one set aside. */
let dir: string;
let path: string;
const disk = () => JSON.parse(readFileSync(path, "utf8")) as { localModels: { managed: Record<string, unknown> } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "set-aside-"));
  path = join(dir, "config.json");
  setConfigNoticeSink(() => {});
  const tree = structuredClone(USER_CONFIG_DEFAULTS) as Record<string, any>;
  tree.version = USER_CONFIG_VERSION;
  tree.localModels.managed = { ...tree.localModels.managed, modelId: "qwen-9.9-from-the-future", engine: "atomic-core-next", backendVariant: "future-gpu" };
  writeFileSync(path, JSON.stringify(tree));
});
afterEach(() => { setConfigNoticeSink(null); rmSync(dir, { recursive: true, force: true }); });

describe("set-aside values survive a whole-file write (ATO-1239)", () => {
  it("an unrelated setting written by this build leaves the newer build's model, engine and variant on disk", () => {
    const parsed = readUserConfigFileSync(path)!;
    expect(parsed.localModels.managed.modelId).toBeNull();
    writeUserConfigFileSync(path, { ...parsed, log: { ...parsed.log, level: "debug" } });
    const m = disk().localModels.managed;
    expect(m.modelId).toBe("qwen-9.9-from-the-future");
    expect(m.engine).toBe("atomic-core-next");
    expect(m.backendVariant).toBe("future-gpu");
  });

  it("a model chosen here replaces it", () => {
    const parsed = readUserConfigFileSync(path)!;
    const known = Object.keys(USER_CONFIG_DEFAULTS).length ? "qwen-3.5-4b" : "";
    writeUserConfigFileSync(path, { ...parsed, localModels: { ...parsed.localModels, managed: { ...parsed.localModels.managed, modelId: known } } });
    expect(disk().localModels.managed.modelId).toBe("qwen-3.5-4b");
  });

  /* ATO-1265: the engine and variant were kept unconditionally, so a choice made here was put back to the newer value. */
  it("an engine chosen here replaces the newer build's engine; the variant nobody touched stays", () => {
    const parsed = readUserConfigFileSync(path)!;
    expect(parsed.localModels.managed.engine).toBe("atomic-core");
    writeUserConfigFileSync(path, { ...parsed, localModels: { ...parsed.localModels, managed: { ...parsed.localModels.managed, engine: "llama-server" } } });
    const m = disk().localModels.managed;
    expect(m.engine).toBe("llama-server");
    expect(m.backendVariant).toBe("future-gpu");
    expect(m.modelId).toBe("qwen-9.9-from-the-future");
  });

  it("a backend variant chosen here replaces the newer build's variant; the engine nobody touched stays", () => {
    const parsed = readUserConfigFileSync(path)!;
    expect(parsed.localModels.managed.backendVariant).toBe("auto");
    writeUserConfigFileSync(path, { ...parsed, localModels: { ...parsed.localModels, managed: { ...parsed.localModels.managed, backendVariant: "cpu" } } });
    const m = disk().localModels.managed;
    expect(m.backendVariant).toBe("cpu");
    expect(m.engine).toBe("atomic-core-next");
  });

  it("after a choice here, a later unrelated write keeps that choice", () => {
    const parsed = readUserConfigFileSync(path)!;
    writeUserConfigFileSync(path, { ...parsed, localModels: { ...parsed.localModels, managed: { ...parsed.localModels.managed, engine: "llama-server", backendVariant: "vulkan" } } });
    const again = readUserConfigFileSync(path)!;
    writeUserConfigFileSync(path, { ...again, log: { ...again.log, level: "debug" } });
    const m = disk().localModels.managed;
    expect(m.engine).toBe("llama-server");
    expect(m.backendVariant).toBe("vulkan");
  });
});
