import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveChatModelWeightsPath } from "../backend-paths.js";
import { buildLocalGgufModelDef } from "../catalog/local-gguf.js";
import {
  getLocalModelDef,
  setCustomLocalModels,
  type LocalModelDef,
} from "../catalog/models-catalog.js";
import {
  downloadMmproj,
  downloadModel,
  isMmprojDownloaded,
  isModelDownloaded,
  removeModel,
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

describe("model-installer: a GGUF added from disk (issue #631)", () => {
  let dir: string;
  let userDir: string;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "local_model-mi-data-"));
    userDir = mkdtempSync(join(tmpdir(), "local_model-mi-user-"));
    prevFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    setCustomLocalModels([]);
    rmSync(dir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  function addFromDisk(): { def: LocalModelDef; path: string } {
    const folder = join(userDir, "My Models");
    mkdirSync(folder);
    const path = join(folder, "model.gguf");
    writeFileSync(path, Buffer.alloc(256, 3));
    const def = buildLocalGgufModelDef({ path, sizeBytes: 256 });
    setCustomLocalModels([def]);
    return { def, path };
  }

  it("launches from the operator's file, not the managed directory", () => {
    const { def, path } = addFromDisk();
    expect(resolveChatModelWeightsPath(dir, def)).toBe(path);
    expect(isModelDownloaded(dir, def)).toBe(true);
  });

  it("never downloads or copies the file", async () => {
    const { def } = addFromDisk();
    const fn = vi.fn();
    globalThis.fetch = fn as unknown as typeof fetch;
    await downloadModel(dir, def);
    expect(fn).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "models", def.id))).toBe(false);
  });

  it("reports a moved file instead of trying to fetch it", async () => {
    const { def, path } = addFromDisk();
    rmSync(path);
    const fn = vi.fn();
    globalThis.fetch = fn as unknown as typeof fetch;
    expect(isModelDownloaded(dir, def)).toBe(false);
    await expect(downloadModel(dir, def)).rejects.toThrow(
      `local model file not found: ${path}`,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it("removal deletes nothing, even inside the managed directory", async () => {
    // The one setup where the guard matters: without it `removeModel`
    // would `rm -r <dataDir>/models/<id>/`, which here holds the file.
    // Adding such a path is refused up front (`resolveLocalGgufFile`),
    // so this is a hand-edited entry — the guard is on the entry, not on
    // where the file happens to be.
    const base = buildLocalGgufModelDef({
      path: join(userDir, "model.gguf"),
      sizeBytes: 64,
    });
    const path = join(dir, "models", base.id, "model.gguf");
    mkdirSync(join(dir, "models", base.id), { recursive: true });
    writeFileSync(path, Buffer.alloc(64, 4));
    setCustomLocalModels([{ ...base, localPath: path }]);
    await removeModel(dir, base.id);
    expect(existsSync(path)).toBe(true);
  });

  it("refuses a file:// URL that lost its localPath instead of fetching it", async () => {
    // What an older build leaves behind after rewriting the list, when
    // the URL does not name a .gguf the parser could recover.
    const def: LocalModelDef = {
      ...buildLocalGgufModelDef({
        path: join(userDir, "model.gguf"),
        sizeBytes: 64,
      }),
      huggingFaceUrl: "file:///nowhere/model.bin",
    };
    delete def.localPath;
    const fn = vi.fn();
    globalThis.fetch = fn as unknown as typeof fetch;
    await expect(downloadModel(dir, def)).rejects.toThrow(
      /points at a file on this machine \(file:\/\/\/nowhere\/model\.bin\), which cannot be downloaded/,
    );
    expect(fn).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "models", def.id))).toBe(false);
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
