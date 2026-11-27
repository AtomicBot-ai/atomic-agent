import { describe, expect, it } from "vitest";
import { parseUserConfigFile, USER_CONFIG_DEFAULTS, USER_CONFIG_VERSION } from "../config-schema.js";

function parsedDraft(value: unknown): unknown {
  return parseUserConfigFile({
    version: USER_CONFIG_VERSION,
    localModels: { managed: { draftModel: value } },
  }).localModels.managed.draftModel;
}

describe("localModels.managed.draftModel (ATO-2424)", () => {
  it("defaults to off, also for a file that predates the key", () => {
    expect(USER_CONFIG_DEFAULTS.localModels.managed.draftModel).toBe("off");
    expect(parseUserConfigFile({ version: USER_CONFIG_VERSION }).localModels.managed.draftModel).toBe("off");
  });

  it("takes off, auto, a model id and an absolute .gguf path", () => {
    expect(parsedDraft("auto")).toBe("auto");
    expect(parsedDraft("off")).toBe("off");
    expect(parsedDraft("gemma-4-e4b")).toBe("gemma-4-e4b");
    const path = process.platform === "win32" ? "C:\\models\\draft.gguf" : "/models/draft.gguf";
    expect(parsedDraft(path)).toBe(path);
  });

  it("refuses anything else, naming the key", () => {
    for (const bad of ["", 3, true, "models/draft.gguf", "/models/draft.bin", "a b"]) {
      expect(() => parsedDraft(bad)).toThrow(/localModels\.managed\.draftModel/);
    }
  });
});
