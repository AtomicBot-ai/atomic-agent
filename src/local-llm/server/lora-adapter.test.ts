import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { coreLoadOverrides } from "../core/core-sessions.js";
import {
  buildLlamaServerArgs,
  readLaunchRecord,
  writeLaunchRecord,
  type DaemonStartOptions,
} from "./daemon-lifecycle.js";
import {
  loraAdapterArgs,
  loraAdapterFileProblem,
  loraAdapterForModel,
  loraAdapterKey,
  loraAdapterShapeProblem,
} from "./lora-adapter.js";

const MODEL = "/tmp/data/models/qwen-3.5-4b/Qwen3.5-4B-Q4_K_M.gguf";
const baseOpts: DaemonStartOptions = { dataDir: "/tmp/data", modelId: "qwen-3.5-4b", port: 19091 };

describe("loraAdapterArgs", () => {
  it("passes an unscaled adapter (or scale 1) as --lora", () => {
    expect(loraAdapterArgs({ path: "/a/style.gguf" })).toEqual(["--lora", "/a/style.gguf"]);
    expect(loraAdapterArgs({ path: "/a/style.gguf", scale: 1 })).toEqual(["--lora", "/a/style.gguf"]);
  });

  it("passes another scale as --lora-scaled FNAME:SCALE, the format the shipped llama-server reads", () => {
    expect(loraAdapterArgs({ path: "/a/style.gguf", scale: 0.5 })).toEqual(["--lora-scaled", "/a/style.gguf:0.5"]);
    expect(loraAdapterArgs({ path: "/a/style.gguf", scale: 0 })).toEqual(["--lora-scaled", "/a/style.gguf:0"]);
  });

  it("adds nothing without an adapter", () => {
    expect(loraAdapterArgs(undefined)).toEqual([]);
  });
});

describe("loraAdapterKey", () => {
  it("names the path, plus the scale only when it is not 1", () => {
    expect(loraAdapterKey(undefined)).toBeNull();
    expect(loraAdapterKey({ path: "/a/style.gguf" })).toBe("/a/style.gguf");
    expect(loraAdapterKey({ path: "/a/style.gguf", scale: 1 })).toBe("/a/style.gguf");
    expect(loraAdapterKey({ path: "/a/style.gguf", scale: 0.8 })).toBe("/a/style.gguf:0.8");
  });
});

describe("loraAdapterShapeProblem", () => {
  const posixAbs = posix.isAbsolute;

  it("accepts an absolute .gguf path with or without a finite scale", () => {
    expect(loraAdapterShapeProblem({ path: "/a/style.gguf" }, posixAbs)).toBeNull();
    expect(loraAdapterShapeProblem({ path: "/a/STYLE.GGUF", scale: -0.5 }, posixAbs)).toBeNull();
  });

  it("refuses an empty, relative or non-gguf path", () => {
    expect(loraAdapterShapeProblem({ path: "" }, posixAbs)).toMatch(/non-empty/);
    expect(loraAdapterShapeProblem({ path: "style.gguf" }, posixAbs)).toMatch(/absolute/);
    expect(loraAdapterShapeProblem({ path: "/a/style.safetensors" }, posixAbs)).toMatch(/\.gguf/);
  });

  it("refuses what llama.cpp would split: a comma, or a colon in a scaled path", () => {
    expect(loraAdapterShapeProblem({ path: "/a/b,c.gguf" }, posixAbs)).toMatch(/comma/);
    expect(
      loraAdapterShapeProblem({ path: "C:\\adapters\\style.gguf", scale: 0.5 }, win32.isAbsolute),
    ).toMatch(/colon/);
    // Unscaled, a drive letter is fine: --lora takes the path as it is.
    expect(loraAdapterShapeProblem({ path: "C:\\adapters\\style.gguf" }, win32.isAbsolute)).toBeNull();
  });

  it("refuses a scale that is not a finite number", () => {
    expect(loraAdapterShapeProblem({ path: "/a/style.gguf", scale: Number.NaN }, posixAbs)).toMatch(/finite/);
    expect(loraAdapterShapeProblem({ path: "/a/style.gguf", scale: Infinity }, posixAbs)).toMatch(/finite/);
  });
});

describe("loraAdapterFileProblem", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("names a missing file and accepts an existing one", () => {
    dir = mkdtempSync(join(tmpdir(), "lora-"));
    const file = join(dir, "style.gguf");
    expect(loraAdapterFileProblem({ path: file })).toBe(`LoRA adapter file not found: ${file}`);
    writeFileSync(file, "GGUF");
    expect(loraAdapterFileProblem({ path: file })).toBeNull();
    // A directory named like an adapter is not one.
    expect(loraAdapterFileProblem({ path: dir })).not.toBeNull();
  });
});

describe("loraAdapterForModel", () => {
  it("returns only the adapter keyed by this model id", () => {
    const adapters = { "qwen-3.5-4b": { path: "/a/style.gguf" } };
    expect(loraAdapterForModel(adapters, "qwen-3.5-4b")).toEqual({ path: "/a/style.gguf" });
    expect(loraAdapterForModel(adapters, "gemma-4-e4b")).toBeUndefined();
    expect(loraAdapterForModel(adapters, "toString")).toBeUndefined();
    expect(loraAdapterForModel(undefined, "qwen-3.5-4b")).toBeUndefined();
  });
});

describe("buildLlamaServerArgs with a LoRA adapter", () => {
  it("appends the adapter after every existing flag, so the historical order stays", () => {
    const without = buildLlamaServerArgs(baseOpts, MODEL, "qwen-3.5-4b");
    const withLora = buildLlamaServerArgs({ ...baseOpts, loraAdapter: { path: "/a/style.gguf", scale: 0.5 } }, MODEL, "qwen-3.5-4b");
    expect(withLora).toEqual([...without, "--lora-scaled", "/a/style.gguf:0.5"]);
  });

  it("keeps the adapter after the vision flags", () => {
    const args = buildLlamaServerArgs(
      { ...baseOpts, mmprojFile: "/m/mmproj.gguf", loraAdapter: { path: "/a/style.gguf" } },
      MODEL,
      "qwen-3.5-4b",
    );
    expect(args.slice(-2)).toEqual(["--lora", "/a/style.gguf"]);
    expect(args).toContain("--mmproj");
  });

  it("reaches Atomic Core through extra_args, which keeps --lora rather than owning it", () => {
    const args = buildLlamaServerArgs({ ...baseOpts, loraAdapter: { path: "/a dir/style.gguf" } }, MODEL, "qwen-3.5-4b");
    expect(coreLoadOverrides(args).extra_args).toContain('"--lora" "/a dir/style.gguf"');
  });
});

describe("launch record LoRA adapter", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("round-trips the adapter key and reads an older record as no adapter", () => {
    dir = mkdtempSync(join(tmpdir(), "lora-launch-"));
    const base = { pid: 42, modelId: "qwen-3.5-4b", contextSize: 32_768, swaFull: false, prefixReuse: null, launchedAt: 1 };
    writeLaunchRecord(dir, { ...base, loraAdapter: "/a/style.gguf:0.5" });
    expect(readLaunchRecord(dir, 42)?.loraAdapter).toBe("/a/style.gguf:0.5");
    writeLaunchRecord(dir, base);
    expect(readLaunchRecord(dir, 42)?.loraAdapter).toBeNull();
  });
});
