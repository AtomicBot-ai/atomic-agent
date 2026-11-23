import { describe, expect, it } from "vitest";

import type { Recipe } from "./recipe-format.js";
import { parseRecipeLink, recipeToLink, RECIPE_LINK_MAX_LENGTH } from "./recipe-link.js";

const RECIPE: Recipe = {
  version: 1,
  title: "Weekly report & more",
  description: "Sums up 100% of a folder",
  prompt: "Summarise {{folder}} for {{who}}.\nUse + and = and ? and # freely.",
  params: [
    { key: "folder", default: "~/Notes/a=b" },
    { key: "who" },
  ],
};

function link(recipe: Recipe): string {
  const r = recipeToLink(recipe);
  if (!r.ok) throw new Error(r.error);
  return r.link;
}

function linkError(raw: string): string {
  const r = parseRecipeLink(raw);
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

describe("recipe links (ATO-1070, the shape ATO-1615 opens)", () => {
  it("makes an atomicagent://recipe/open link", () => {
    const made = link(RECIPE);
    expect(made.startsWith("atomicagent://recipe/open?title=Weekly%20report%20%26%20more&description=")).toBe(true);
    expect(made).toContain("&param=folder%3D~%2FNotes%2Fa%3Db&param=who");
    // The raw link carries no line break: the app refuses control characters in it.
    expect(/[\n\r\t]/.test(made)).toBe(false);
  });

  it("round-trips through the link", () => {
    const back = parseRecipeLink(link(RECIPE));
    expect(back).toEqual({ ok: true, recipe: RECIPE });
  });

  it("drops a parameter's description, which a link has no room for", () => {
    const withHint: Recipe = { ...RECIPE, params: [{ key: "folder", description: "Where" }, { key: "who" }] };
    const back = parseRecipeLink(link(withHint));
    expect(back).toEqual({ ok: true, recipe: { ...RECIPE, params: [{ key: "folder" }, { key: "who" }] } });
  });

  it("reads a hand-written link the way the desktop does", () => {
    const r = parseRecipeLink("atomicagent://recipe/open?name=Hi&prompt=Hello%20{{ who }}&param=who=Ana");
    expect(r).toEqual({ ok: true, recipe: { version: 1, title: "Hi", prompt: "Hello {{ who }}", params: [{ key: "who", default: "Ana" }] } });
  });

  it("refuses a link that would be too long", () => {
    const r = recipeToLink({ ...RECIPE, prompt: `${"€".repeat(2000)} {{folder}} {{who}}` });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(`${RECIPE_LINK_MAX_LENGTH}`);
  });

  it("refuses a link for text with hidden characters", () => {
    const r = recipeToLink({ ...RECIPE, title: "Report‮txt.exe" });
    expect(r.ok).toBe(false);
  });

  it("refuses keys that would pick the model, tools or permissions", () => {
    for (const key of ["model", "tools", "mcp", "skill", "permissions", "send", "run"]) {
      expect(linkError(`atomicagent://recipe/open?title=t&prompt=hi&${key}=x`)).toContain("cannot choose");
    }
  });

  it("refuses unknown keys, repeats, other hosts and paths", () => {
    expect(linkError("atomicagent://recipe/open?title=t&prompt=hi&author=me")).toContain('("author")');
    expect(linkError("atomicagent://recipe/open?title=t&title=u&prompt=hi")).toContain("more than once");
    expect(linkError("atomicagent://skill/install?slug=x")).toContain("Not a recipe link");
    expect(linkError("atomicagent://recipe/run?title=t&prompt=hi")).toContain("only open");
    expect(linkError("https://example.com/recipe.yaml")).toContain("Not an atomicagent");
  });

  it("applies the recipe rules to a link", () => {
    expect(linkError("atomicagent://recipe/open?title=t&prompt=Look%20at%20{{folder}}")).toContain("{{folder}}");
    expect(linkError("atomicagent://recipe/open?title=t&prompt=hi&param=folder")).toContain("not used");
    expect(linkError("atomicagent://recipe/open?title=t&prompt={{a}}&param=a&param=a")).toContain("given twice");
    expect(linkError("atomicagent://recipe/open?prompt=hi")).toContain("no title");
  });
});
