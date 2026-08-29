import { describe, expect, it } from "vitest";

import { parseCustomLocalModel, parseCustomLocalModels } from "./custom-models-schema.js";
import { USER_CONFIG_DEFAULTS, parseUserConfigFile } from "./config-schema.js";

const MINIMAL = {
  id: "custom-unsloth-qwen3-4b-gguf-qwen3-4b-ud-q4_k_xl",
  filename: "Qwen3-4B-UD-Q4_K_XL.gguf",
  huggingFaceUrl:
    "https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-UD-Q4_K_XL.gguf",
};

describe("parseCustomLocalModel", () => {
  it("fills in everything cosmetic so a hand-written entry can stay short", () => {
    const def = parseCustomLocalModel(MINIMAL, "e");
    expect(def.name).toBe(MINIMAL.id);
    expect(def.family).toBe("custom");
    expect(def.contextLabel).toBe("auto");
    expect(def.maxContextLength).toBe(0);
    expect(def.supportsVision).toBe(false);
  });

  const bad: { name: string; entry: unknown; field: RegExp }[] = [
    { name: "a missing id", entry: { ...MINIMAL, id: undefined }, field: /e\.id/ },
    // The id becomes a directory name under `<dataDir>/models/`.
    { name: "an id with a path separator", entry: { ...MINIMAL, id: "custom-a/b" }, field: /e\.id/ },
    { name: "an id without the prefix", entry: { ...MINIMAL, id: "qwen-3.5-4b" }, field: /e\.id/ },
    // Filenames land in a path join under the model's own directory.
    { name: "a filename with a path separator", entry: { ...MINIMAL, filename: "a/b.gguf" }, field: /e\.filename/ },
    { name: "a filename that climbs out", entry: { ...MINIMAL, filename: "../../../x.gguf" }, field: /e\.filename/ },
    { name: "a backslashed filename", entry: { ...MINIMAL, filename: "..\\x.gguf" }, field: /e\.filename/ },
    { name: "an unparseable URL", entry: { ...MINIMAL, huggingFaceUrl: "nope" }, field: /huggingFaceUrl/ },
    { name: "a negative size", entry: { ...MINIMAL, fileSizeGb: -1 }, field: /fileSizeGb/ },
    { name: "a bare string", entry: "custom-x", field: /^invalid config: e/ },
  ];

  for (const row of bad) {
    it(`rejects ${row.name}`, () => {
      expect(() => parseCustomLocalModel(row.entry, "e")).toThrow(row.field);
    });
  }

  it("holds the projector filename to the same rule as the weights'", () => {
    expect(() =>
      parseCustomLocalModel(
        {
          ...MINIMAL,
          supportsVision: true,
          mmprojUrl: "https://huggingface.co/u/r/resolve/main/mmproj.gguf",
          mmprojFilename: "../mmproj.gguf",
        },
        "e",
      ),
    ).toThrow(/e\.mmprojFilename/);
  });

  it("demands the projector fields once vision is claimed", () => {
    expect(() =>
      parseCustomLocalModel({ ...MINIMAL, supportsVision: true }, "e"),
    ).toThrow(/mmprojUrl/);
  });
});

describe("parseCustomLocalModels", () => {
  it("reads a missing block as no added models", () => {
    expect(parseCustomLocalModels(undefined, "f")).toEqual([]);
  });

  it("refuses two entries under one id", () => {
    expect(() => parseCustomLocalModels([MINIMAL, MINIMAL], "f")).toThrow(/duplicate/);
  });
});

describe("localModels.customModels in a whole config file", () => {
  it("lets an added model be the active one in the same write", () => {
    const parsed = parseUserConfigFile({
      ...USER_CONFIG_DEFAULTS,
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        customModels: [MINIMAL],
        managed: { ...USER_CONFIG_DEFAULTS.localModels.managed, modelId: MINIMAL.id },
      },
    });
    expect(parsed.localModels.managed.modelId).toBe(MINIMAL.id);
    expect(parsed.localModels.customModels).toHaveLength(1);
  });

  it("still refuses an active id that names nothing", () => {
    expect(() =>
      parseUserConfigFile({
        ...USER_CONFIG_DEFAULTS,
        localModels: {
          ...USER_CONFIG_DEFAULTS.localModels,
          customModels: [],
          managed: { ...USER_CONFIG_DEFAULTS.localModels.managed, modelId: MINIMAL.id },
        },
      }),
    ).toThrow(/unknown managed local model id/);
  });

  // The key is additive, so a file written before it existed has to read
  // exactly as it did then.
  it("upgrades a file from the previous version with an empty list", () => {
    const previous = { ...USER_CONFIG_DEFAULTS, version: 43 } as Record<string, unknown>;
    delete (previous.localModels as Record<string, unknown>).customModels;
    expect(parseUserConfigFile(previous).localModels.customModels).toEqual([]);
  });
});
