import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildLocalGgufModelDef,
  buildLocalGgufModelId,
  describeMissingLocalGguf,
  looksLikeLocalGgufPath,
  MANAGED_GGUF_PATH_ERROR,
  resolveLocalGgufFile,
} from "./local-gguf.js";

describe("looksLikeLocalGgufPath", () => {
  it.each([
    "/models/qwen.gguf",
    "~/models/qwen.gguf",
    `"/Users/me/My Models/qwen.gguf"`,
    "C:\\models\\qwen.gguf",
  ])("treats %s as a local path", (raw) => {
    expect(looksLikeLocalGgufPath(raw)).toBe(true);
  });

  it.each([
    "unsloth/Qwen3.5-4B-GGUF",
    "https://huggingface.co/owner/repo",
    "hf://owner/repo/file.gguf",
    "hf download owner/repo file.gguf",
    "",
  ])("leaves %s to the Hugging Face parser", (raw) => {
    expect(looksLikeLocalGgufPath(raw)).toBe(false);
  });
});

describe("resolveLocalGgufFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "local-gguf-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts an absolute path to an existing .gguf, spaces included", () => {
    const folder = join(dir, "My Models");
    mkdirSync(folder);
    const path = join(folder, "Qwen 3 4B Q4.gguf");
    writeFileSync(path, Buffer.alloc(2048, 1));

    expect(resolveLocalGgufFile(path)).toEqual({ path, sizeBytes: 2048 });
    // A dragged-in path arrives quoted.
    expect(resolveLocalGgufFile(`'${path}'`).path).toBe(path);
  });

  it("expands ~ against the home directory", () => {
    const path = join(dir, "model.gguf");
    writeFileSync(path, "x");
    expect(resolveLocalGgufFile("~/model.gguf", { homeDir: dir }).path).toBe(
      path,
    );
  });

  it("says plainly when the file does not exist", () => {
    const path = join(dir, "missing.gguf");
    expect(() => resolveLocalGgufFile(path)).toThrow(`No such file: ${path}`);
  });

  it("rejects a file that is not a .gguf", () => {
    const path = join(dir, "model.safetensors");
    writeFileSync(path, "x");
    expect(() => resolveLocalGgufFile(path)).toThrow(
      `Not a .gguf file: ${path}`,
    );
  });

  it("rejects a directory named like a .gguf", () => {
    const path = join(dir, "folder.gguf");
    mkdirSync(path);
    expect(() => resolveLocalGgufFile(path)).toThrow(`Not a file: ${path}`);
  });

  it("says in words that a leading-dot file name is not supported", () => {
    const path = join(dir, ".model.gguf");
    writeFileSync(path, "x");
    expect(() => resolveLocalGgufFile(path)).toThrow(
      "File names starting with a dot are not supported: .model.gguf. Rename the file and try again.",
    );
  });

  it("refuses a file inside the managed models directory", () => {
    const managed = join(dir, "data", "models");
    mkdirSync(join(managed, "qwen-3.5-4b"), { recursive: true });
    const path = join(managed, "qwen-3.5-4b", "model.gguf");
    writeFileSync(path, "x");
    expect(() =>
      resolveLocalGgufFile(path, { managedModelsDir: managed }),
    ).toThrow(MANAGED_GGUF_PATH_ERROR);
    // Outside the store the same option lets the file through.
    const outside = join(dir, "model.gguf");
    writeFileSync(outside, "x");
    expect(
      resolveLocalGgufFile(outside, { managedModelsDir: managed }).path,
    ).toBe(outside);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlink that leads into the managed models directory",
    () => {
      const managed = join(dir, "data", "models");
      mkdirSync(join(managed, "qwen-3.5-4b"), { recursive: true });
      const target = join(managed, "qwen-3.5-4b", "model.gguf");
      writeFileSync(target, "x");
      const link = join(dir, "link.gguf");
      symlinkSync(target, link);
      expect(() =>
        resolveLocalGgufFile(link, { managedModelsDir: managed }),
      ).toThrow(MANAGED_GGUF_PATH_ERROR);
    },
  );

  it("rejects a relative path", () => {
    expect(() => resolveLocalGgufFile("models/qwen.gguf")).toThrow(
      /absolute path/,
    );
  });
});

describe("describeMissingLocalGguf", () => {
  it("names the path and offers no download", () => {
    const text = describeMissingLocalGguf("/models/model.gguf");
    expect(text).toContain("local file is missing at /models/model.gguf");
    expect(text).not.toMatch(/press Enter|downloading now/);
  });
});

describe("buildLocalGgufModelDef", () => {
  it("registers the file where it lies, under a stable custom id", () => {
    const path = "/Users/me/My Models/Qwen3-4B-Q4_K_M.gguf";
    const def = buildLocalGgufModelDef({ path, sizeBytes: 2 * 1024 ** 3 });
    expect(def.id).toBe(buildLocalGgufModelId(path));
    expect(def.id).toMatch(/^custom-local-qwen3-4b-q4_k_m-[0-9a-f]{8}$/);
    expect(def.localPath).toBe(path);
    expect(def.filename).toBe("Qwen3-4B-Q4_K_M.gguf");
    expect(def.family).toBe("custom");
    expect(def.supportsVision).toBe(false);
  });

  it("keeps same-named files in different folders apart", () => {
    expect(buildLocalGgufModelId("/a/model.gguf")).not.toBe(
      buildLocalGgufModelId("/b/model.gguf"),
    );
  });
});
