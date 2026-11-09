import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LocalModelDef, LocalModelId } from "../../local-llm/index.js";
import { takeModelSpotlightHint } from "./model-spotlight-hint.js";

function def(id: string, recommendedRamGb: number): LocalModelDef {
  return {
    id: id as LocalModelId,
    name: `Model ${id}`,
    filename: `${id}.gguf`,
    huggingFaceUrl: "https://example.invalid/model.gguf",
    fileSizeGb: 4,
    sizeLabel: "4.0 GB",
    description: "test model",
    maxContextLength: 8192,
    contextLabel: "8K",
    minRamGb: 4,
    recommendedRamGb,
    family: "qwen",
    supportsVision: false,
    spotlight: true,
  };
}

describe("takeModelSpotlightHint", () => {
  let stateDir: string;
  let seenFile: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-spotlight-hint-"));
    seenFile = join(stateDir, "model-spotlight-seen.json");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  function take(
    catalog: readonly LocalModelDef[],
    over: {
      firstRun?: boolean;
      stateDir?: string;
      isDownloaded?: (m: LocalModelDef) => boolean;
    } = {},
  ): string | null {
    return takeModelSpotlightHint({
      stateDir: over.stateDir ?? stateDir,
      dataDir: join(stateDir, "models"),
      firstRun: over.firstRun ?? false,
      catalog,
      memoryGb: 32,
      isDownloaded: over.isDownloaded ?? (() => false),
    });
  }

  it("names the model, its size and the commands that fetch it", () => {
    expect(take([def("qwen-4-9b", 16)])).toBe(
      "New model: Model qwen-4-9b, 4.0 GB. Run /model pull qwen-4-9b to download and start it, or /local to see all local models.",
    );
  });

  it("shows once per model id, across launches", () => {
    const catalog = [def("qwen-4-9b", 16)];
    expect(take(catalog)).not.toBeNull();
    expect(take(catalog)).toBeNull();
    expect(JSON.parse(readFileSync(seenFile, "utf8"))).toEqual({ seen: ["qwen-4-9b"] });
  });

  it("shows again for the next launch's model and keeps the old record", () => {
    expect(take([def("qwen-4-9b", 16)])).not.toBeNull();
    expect(take([def("qwen-5-9b", 16)])).not.toBeNull();
    expect(JSON.parse(readFileSync(seenFile, "utf8"))).toEqual({
      seen: ["qwen-4-9b", "qwen-5-9b"],
    });
  });

  it("is not shown, and records nothing, when no model is in the spotlight", () => {
    expect(take([])).toBeNull();
    expect(take([{ ...def("old", 16), spotlight: undefined }])).toBeNull();
    expect(take([def("qwen-4-9b", 16)], { isDownloaded: () => true })).toBeNull();
    expect(existsSync(seenFile)).toBe(false);
  });

  it("stays quiet during first-run setup and is still shown afterwards", () => {
    const catalog = [def("qwen-4-9b", 16)];
    expect(take(catalog, { firstRun: true })).toBeNull();
    expect(existsSync(seenFile)).toBe(false);
    expect(take(catalog)).not.toBeNull();
  });

  it("treats a corrupt record as empty", () => {
    writeFileSync(seenFile, "{not json");
    expect(take([def("qwen-4-9b", 16)])).not.toBeNull();
  });

  it("holds the hint back when it cannot be recorded", () => {
    // A file where the state dir should be: mkdir and the write both fail.
    const blocked = join(stateDir, "blocked");
    writeFileSync(blocked, "");
    expect(take([def("qwen-4-9b", 16)], { stateDir: blocked })).toBeNull();
  });
});
