import { describe, expect, it } from "vitest";

import { OllamaProvider as PublicOllamaProvider } from "../index.js";
import { OllamaProvider as LocalOllamaProvider } from "./index.js";

describe("Ollama provider exports", () => {
  it("is available from the feature and public provider barrels", () => {
    expect(LocalOllamaProvider).toBe(PublicOllamaProvider);
  });
});
