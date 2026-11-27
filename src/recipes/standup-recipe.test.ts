import { describe, expect, it } from "vitest";

import { checkRecipe } from "./recipe-check.js";
import { parseRecipe, recipeToYaml, renderRecipePrompt } from "./recipe-format.js";
import { parseRecipeLink, recipeToLink } from "./recipe-link.js";
import { STANDUP_RECIPE } from "./standup-recipe.js";

describe("Standup for the day recipe", () => {
  it("is a valid recipe that reads back unchanged from its file and its link", () => {
    const fromFile = parseRecipe(recipeToYaml(STANDUP_RECIPE));
    expect(fromFile).toEqual({ ok: true, recipe: STANDUP_RECIPE });
    const link = recipeToLink(STANDUP_RECIPE);
    expect(link.ok).toBe(true);
    if (!link.ok) return;
    const back = parseRecipeLink(link.link);
    expect(back.ok && back.recipe.prompt).toBe(STANDUP_RECIPE.prompt);
  });

  it("passes the content check and asks for the logbook tool", () => {
    expect(checkRecipe(STANDUP_RECIPE).verdict).toBe("ok");
    const text = renderRecipePrompt(STANDUP_RECIPE);
    expect(text).toContain('logbook.query with day "yesterday"');
    expect(renderRecipePrompt(STANDUP_RECIPE, { day: "2026-11-26" })).toContain("standup for 2026-11-26");
  });
});
