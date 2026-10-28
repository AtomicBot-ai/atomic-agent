import { describe, expect, it } from "vitest";

import { MODEL_TIERS } from "../../llm/provider/presets/model-tiers.js";
import { listOpenRouterChatModels, withModelTiersFirst } from "./providers-model-options.js";

describe("Cheap / Balanced / Best first in the picker (ATO-32)", () => {
  it("leads the OpenRouter list with the three picks, labelled, and lists each model once", () => {
    const list = listOpenRouterChatModels();
    const t = MODEL_TIERS.openrouter!;
    expect(list.slice(0, 3).map((o) => o.id)).toEqual([t.cheap, t.balanced, t.best]);
    expect(list[0]!.label.startsWith(`Cheap · ${t.cheap} · `)).toBe(true);
    expect(list[2]!.label.startsWith("Best · ")).toBe(true);
    expect(new Set(list.map((o) => o.id)).size).toBe(list.length);
  });

  it("skips a tier the list does not carry and leaves an untiered kind alone", () => {
    const options = [
      { id: "x", label: "x" },
      { id: MODEL_TIERS.openrouter!.best, label: "best-row" },
    ];
    expect(withModelTiersFirst("openrouter", options).map((o) => o.label)).toEqual(["Best · best-row", "x"]);
    expect(withModelTiersFirst("codex-cli", options)).toBe(options);
  });
});
