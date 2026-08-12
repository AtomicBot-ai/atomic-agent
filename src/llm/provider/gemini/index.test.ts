import { describe, expect, it } from "vitest";

import { GeminiProvider as PublicGeminiProvider } from "../index.js";
import { GeminiProvider as LocalGeminiProvider } from "./index.js";

describe("Gemini provider exports", () => {
  it("is available from the feature and public provider barrels", () => {
    expect(LocalGeminiProvider).toBe(PublicGeminiProvider);
  });
});