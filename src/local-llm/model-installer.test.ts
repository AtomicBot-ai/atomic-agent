import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getLocalModelDef,
  type LocalModelDef,
} from "./models-catalog.js";
import {
  downloadMmproj,
  downloadModel,
  isMmprojDownloaded,
  isModelDownloaded,
} from "./model-installer.js";

describe("model-installer", () => {
  let dir: string;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "local_model-mi-"));
    prevFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  it("downloads model file when missing", async () => {
    const model = getLocalModelDef("qwen-3.5-4b");
    const payload = Buffer.alloc(1024, 7);
    globalThis.fetch = vi.fn(async () => {
      return new Response(payload, {
        status: 200,
        headers: { "content-length": String(payload.length) },
      });
    }) as typeof fetch;

    await downloadModel(dir, model);
    const path = join(dir, "models", model.id, model.filename);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).length).toBe(1024);
    expect(isModelDownloaded(dir, model)).toBe(true);
  });

  it("skips download when file already exists", async () => {
    const model = getLocalModelDef("qwen-3.5-4b");
    const payload = Buffer.alloc(64, 1);
    const fn = vi.fn(async () => {
      return new Response(payload, {
        status: 200,
        headers: { "content-length": String(payload.length) },
      });
    });
    globalThis.fetch = fn as unknown as typeof fetch;
    await downloadModel(dir, model);
    await downloadModel(dir, model);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("downloads mmproj projector for vision-capable models", async () => {
    const model = getLocalModelDef("gemma-4-e4b");
    expect(model.supportsVision).toBe(true);
    const payload = Buffer.alloc(512, 9);
    globalThis.fetch = vi.fn(async () => {
      return new Response(payload, {
        status: 200,
        headers: { "content-length": String(payload.length) },
      });
    }) as typeof fetch;

    expect(isMmprojDownloaded(dir, model)).toBe(false);
    await downloadMmproj(dir, model);
    const path = join(dir, "models", model.id, model.mmprojFilename!);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).length).toBe(512);
    expect(isMmprojDownloaded(dir, model)).toBe(true);
  });

  it("skips mmproj download when projector already exists", async () => {
    const model = getLocalModelDef("gemma-4-e4b");
    const payload = Buffer.alloc(64, 2);
    const fn = vi.fn(async () => {
      return new Response(payload, {
        status: 200,
        headers: { "content-length": String(payload.length) },
      });
    });
    globalThis.fetch = fn as unknown as typeof fetch;
    await downloadMmproj(dir, model);
    await downloadMmproj(dir, model);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rejects mmproj download for text-only models", async () => {
    const model = makeTextOnlyModelDef();
    await expect(downloadMmproj(dir, model)).rejects.toThrow(
      /not vision-capable/,
    );
  });

  it("isMmprojDownloaded returns false for text-only models", () => {
    const model = makeTextOnlyModelDef();
    expect(isMmprojDownloaded(dir, model)).toBe(false);
  });
});

/**
 * The shipping catalog now flags every entry as `supportsVision: true`,
 * so we hand-craft a synthetic text-only `LocalModelDef` to exercise
 * the guard branch in `downloadMmproj` / `isMmprojDownloaded`. The
 * id field uses a real `LocalModelId` literal because the type is a
 * closed union — runtime code never resolves this id through the
 * catalog (the test only passes the def directly to the installer).
 */
function makeTextOnlyModelDef(): LocalModelDef {
  return {
    id: "qwen-3.5-4b",
    name: "synthetic text-only model",
    filename: "synthetic.gguf",
    huggingFaceUrl: "https://example.invalid/synthetic.gguf",
    fileSizeGb: 1,
    sizeLabel: "1 GB",
    description: "test fixture",
    maxContextLength: 4096,
    contextLabel: "4K",
    minRamGb: 4,
    recommendedRamGb: 4,
    family: "qwen",
    supportsVision: false,
  };
}
