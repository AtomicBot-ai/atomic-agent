import { describe, expect, it } from "vitest";
import { LOCAL_MODELS_CATALOG } from "./models-catalog.js";

describe("catalog draft pairing (ATO-2424)", () => {
  const paired = LOCAL_MODELS_CATALOG.filter((m) => m.draftModelId !== undefined);

  it("pairs at least one model, gemma-4-31b with gemma-4-e4b", () => {
    expect(LOCAL_MODELS_CATALOG.find((m) => m.id === "gemma-4-31b")?.draftModelId).toBe("gemma-4-e4b");
  });

  it("every draft is another catalog model, of the same family, at most a third of the size", () => {
    for (const m of paired) {
      const draft = LOCAL_MODELS_CATALOG.find((d) => d.id === m.draftModelId);
      expect(draft, `${m.id} -> ${m.draftModelId}`).toBeDefined();
      expect(draft!.id).not.toBe(m.id);
      expect(draft!.family).toBe(m.family);
      expect(draft!.fileSizeGb).toBeLessThanOrEqual(m.fileSizeGb / 3);
      expect(draft!.uncensored).not.toBe(true);
    }
  });

  it("pairs no Qwen 3.5+ or Nemotron model: their recurrent state cannot take back draft tokens", () => {
    for (const m of paired) expect(m.family === "qwen" || m.family === "nemotron", m.id).toBe(false);
  });
});
