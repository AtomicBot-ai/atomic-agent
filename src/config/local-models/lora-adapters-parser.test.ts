import { posix } from "node:path";

import { describe, expect, it } from "vitest";

import { createLocalModelsDefaults } from "./local-models-defaults.js";
import { parseUserLocalModelsConfig, prepareLocalModelsInputs } from "./local-models-parser.js";
import { parseLoraAdapters } from "./lora-adapters-parser.js";
import { ConfigValidationError } from "../config-validation-error.js";

const FIELD = "localModels.managed.loraAdapters";

function parseLocal(raw: Record<string, unknown>, version = 74) {
  const defaults = createLocalModelsDefaults();
  return parseUserLocalModelsConfig(prepareLocalModelsInputs(raw, version, () => defaults), () => defaults);
}

function thrown(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("expected the LoRA adapter fixture to be rejected");
}

describe("parseLoraAdapters (ATO-1106)", () => {
  it("reads absent or null as no adapters, so an older file is unchanged", () => {
    expect(parseLoraAdapters(undefined, FIELD)).toBeUndefined();
    expect(parseLoraAdapters(null, FIELD)).toBeUndefined();
    expect(parseLocal({}).managed).not.toHaveProperty("loraAdapters");
  });

  it("keeps a per-model path and optional scale", () => {
    expect(
      parseLoraAdapters(
        { "qwen-3.5-4b": { path: "/a/style.gguf", scale: 0.5 }, "custom-x": { path: "/a/x.gguf" } },
        FIELD,
        posix.isAbsolute,
      ),
    ).toEqual({ "qwen-3.5-4b": { path: "/a/style.gguf", scale: 0.5 }, "custom-x": { path: "/a/x.gguf" } });
  });

  it("reaches the managed config through the local-models parser", () => {
    const adapter = { path: posix.join(process.platform === "win32" ? "C:/" : "/", "a", "style.gguf") };
    expect(parseLocal({ managed: { loraAdapters: { "qwen-3.5-4b": adapter } } }).managed.loraAdapters)
      .toEqual({ "qwen-3.5-4b": adapter });
  });

  it("names the field and the model of a bad entry", () => {
    const cases: Array<[unknown, string]> = [
      [[], FIELD],
      [{ "qwen-3.5-4b": "/a/style.gguf" }, `${FIELD}["qwen-3.5-4b"]`],
      [{ "qwen-3.5-4b": { path: 7 } }, `${FIELD}["qwen-3.5-4b"].path`],
      [{ "qwen-3.5-4b": { path: "/a/style.gguf", scale: "0.5" } }, `${FIELD}["qwen-3.5-4b"].scale`],
      [{ "qwen-3.5-4b": { path: "relative.gguf" } }, `${FIELD}["qwen-3.5-4b"]`],
      [{ "qwen-3.5-4b": { path: "/a/style.bin" } }, `${FIELD}["qwen-3.5-4b"]`],
    ];
    for (const [raw, field] of cases) {
      const error = thrown(() => parseLoraAdapters(raw, FIELD, posix.isAbsolute));
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error).toMatchObject({ field });
    }
  });

  it("does not check the disk at load time: a missing adapter fails its launch instead", () => {
    expect(parseLoraAdapters({ m: { path: "/not/mounted/style.gguf" } }, FIELD, posix.isAbsolute))
      .toEqual({ m: { path: "/not/mounted/style.gguf" } });
  });
});
