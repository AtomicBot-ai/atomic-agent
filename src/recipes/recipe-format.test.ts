import { describe, expect, it } from "vitest";

import {
  parseRecipe,
  recipeToYaml,
  renderRecipePrompt,
  RECIPE_FILE_MAX_BYTES,
  RECIPE_MAX_PARAMS,
  RECIPE_PROMPT_MAX,
  RECIPE_TITLE_MAX,
  type Recipe,
} from "./recipe-format.js";

const YAML = [
  "version: 1",
  "title: Weekly report",
  "description: Sums up a folder of notes",
  "prompt: |",
  "  Summarise the notes in {{folder}} for {{ who }}.",
  "  Keep it short.",
  "params:",
  "  - key: folder",
  "    default: ~/Notes",
  "  - key: who",
  "    description: Who reads the summary",
  "",
].join("\n");

function ok(text: string): Recipe {
  const r = parseRecipe(text);
  if (!r.ok) throw new Error(r.error);
  return r.recipe;
}

function error(text: string): string {
  const r = parseRecipe(text);
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

describe("parseRecipe (ATO-1070)", () => {
  it("reads a YAML recipe", () => {
    expect(ok(YAML)).toEqual({
      version: 1,
      title: "Weekly report",
      description: "Sums up a folder of notes",
      prompt: "Summarise the notes in {{folder}} for {{ who }}.\nKeep it short.",
      params: [
        { key: "folder", default: "~/Notes" },
        { key: "who", description: "Who reads the summary" },
      ],
    });
  });

  it("reads the same recipe as JSON, version optional, name as title", () => {
    const r = ok(JSON.stringify({ name: "Hi", prompt: "Say hi to {{who}}", params: [{ key: "who", default: 5 }] }));
    expect(r).toEqual({ version: 1, title: "Hi", prompt: "Say hi to {{who}}", params: [{ key: "who", default: "5" }] });
  });

  it("never throws on broken input", () => {
    expect(error("")).toContain("empty");
    expect(error("title: [unclosed")).toContain("not valid YAML or JSON");
    expect(error("{ not json")).toContain("not valid YAML or JSON");
    expect(error("- a\n- b\n")).toContain("mapping");
    expect(error("just text")).toContain("mapping");
    expect(parseRecipe(42 as unknown as string).ok).toBe(false);
  });

  it("refuses a placeholder the params do not declare", () => {
    expect(error("title: t\nprompt: Look at {{folder}}\n")).toContain("{{folder}}");
    expect(error("title: t\nprompt: Look at {{}}\n")).toContain("{{}}");
  });

  it("refuses a param the prompt does not use", () => {
    expect(error("title: t\nprompt: hello\nparams:\n  - key: folder\n")).toContain("folder is not used");
  });

  it("refuses bad, repeated and too many param keys", () => {
    expect(error("title: t\nprompt: '{{Folder}}'\nparams:\n  - key: Folder\n")).toContain("lowercase");
    expect(error("title: t\nprompt: '{{a}}'\nparams:\n  - key: a\n  - key: a\n")).toContain("given twice");
    expect(error("title: t\nprompt: '{{a}}'\nparams:\n  - key: a\n    label: A\n")).toContain("label");
    const keys = Array.from({ length: RECIPE_MAX_PARAMS + 1 }, (_, i) => `k${i}`);
    const many = JSON.stringify({ title: "t", prompt: keys.map((k) => `{{${k}}}`).join(" "), params: keys.map((key) => ({ key })) });
    expect(error(many)).toContain(`at most ${RECIPE_MAX_PARAMS}`);
  });

  it.each(["model", "provider", "tools", "mcp", "skills", "permissions", "approval", "send", "run", "extensions", "settings", "Model"])(
    "refuses the %s key by name",
    (key) => {
      expect(error(`title: t\nprompt: hi\n${key}: x\n`)).toContain("cannot choose the model, tools");
    },
  );

  it("refuses any other unknown key", () => {
    expect(error("title: t\nprompt: hi\nauthor: me\n")).toContain('("author")');
  });

  it("refuses another version", () => {
    expect(error("version: 2\ntitle: t\nprompt: hi\n")).toContain("version 1");
  });

  it("enforces the size caps", () => {
    expect(error(`title: ${"t".repeat(RECIPE_TITLE_MAX + 1)}\nprompt: hi\n`)).toContain("title is longer");
    expect(error(JSON.stringify({ title: "t", prompt: "p".repeat(RECIPE_PROMPT_MAX + 1) }))).toContain("prompt is longer");
    expect(error(JSON.stringify({ title: "t", prompt: "{{a}}", params: [{ key: "a", default: "d".repeat(501) }] }))).toContain("default for a");
    expect(error(`title: t\nprompt: hi\n# ${"x".repeat(RECIPE_FILE_MAX_BYTES)}\n`)).toContain("larger than");
  });

  it("refuses a multi-line title and control characters in the prompt", () => {
    expect(error(JSON.stringify({ title: "a\nb", prompt: "hi" }))).toContain("one line");
    expect(error(JSON.stringify({ title: "t", prompt: "hi\u0007" }))).toContain("control characters");
  });

  it("refuses a missing title or prompt", () => {
    expect(error("prompt: hi\n")).toContain("no title");
    expect(error("title: t\n")).toContain("no prompt");
  });
});

describe("renderRecipePrompt", () => {
  const recipe = ok(YAML);

  it("fills values, then defaults, and leaves the rest as written", () => {
    expect(renderRecipePrompt(recipe, { who: "Ana" })).toBe("Summarise the notes in ~/Notes for Ana.\nKeep it short.");
    expect(renderRecipePrompt(recipe)).toBe("Summarise the notes in ~/Notes for {{ who }}.\nKeep it short.");
  });

  it("does not expand a placeholder inside a value", () => {
    expect(renderRecipePrompt(recipe, { folder: "{{who}}", who: "x" })).toContain("notes in {{who}} for x");
  });
});

describe("recipeToYaml", () => {
  it("writes a file parseRecipe reads back unchanged", () => {
    const recipe = ok(YAML);
    expect(ok(recipeToYaml(recipe))).toEqual(recipe);
  });

  it("keeps a long line and odd characters intact", () => {
    const recipe: Recipe = {
      version: 1,
      title: "Quote: \"x\" # not a comment",
      prompt: `${"word ".repeat(60)}{{a}}\n- not a list\n  indented: yes`,
      params: [{ key: "a", default: "~" }],
    };
    expect(ok(recipeToYaml(recipe))).toEqual(recipe);
  });
});
