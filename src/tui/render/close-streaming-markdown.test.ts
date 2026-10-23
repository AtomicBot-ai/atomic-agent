import { describe, expect, it } from "vitest";

import { closeStreamingMarkdown } from "./close-streaming-markdown.js";

describe("closeStreamingMarkdown", () => {
  it.each([
    ["hello **bold", "hello **bold**"],
    ["see `foo", "see `foo`"],
    ["x ``a` b", "x ``a` b``"],
    ["done **ok** and ~~old", "done **ok** and ~~old~~"],
    ["a **b *c", "a **b *c***"],
    ["**see `foo", "**see `foo`**"],
    ["* item **x", "* item **x**"],
    ["***both", "***both***"],
  ])("closes open inline markup: %j", (input, expected) => {
    expect(closeStreamingMarkdown(input)).toBe(expected);
  });

  it("drops an opener that nothing follows yet instead of rendering ****", () => {
    expect(closeStreamingMarkdown("hello **")).toBe("hello ");
    expect(closeStreamingMarkdown("hello **bold** and `")).toBe("hello **bold** and ");
  });

  it("closes onto the last word, not after trailing spaces", () => {
    expect(closeStreamingMarkdown("hello **bold ")).toBe("hello **bold**");
  });

  it("shows a half-written link as its label", () => {
    expect(closeStreamingMarkdown("go to [docs](https://exa")).toBe("go to docs");
    expect(closeStreamingMarkdown("go to [docs")).toBe("go to docs");
    expect(closeStreamingMarkdown("go to [docs](https://example.com) now")).toBe(
      "go to [docs](https://example.com) now",
    );
  });

  it("leaves text that is not open markup alone", () => {
    for (const text of ["2 * 3 = 6", "snake_case_name", "a \\*b", "plain text", ""]) {
      expect(closeStreamingMarkdown(text)).toBe(text);
    }
  });

  it("touches only the last block", () => {
    expect(closeStreamingMarkdown("first **para\n\nsecond **new")).toBe(
      "first **para\n\nsecond **new**",
    );
  });

  it("does not touch the inside of an open code fence", () => {
    const text = "Here:\n\n```js\nconst a = '**';\nconst b = `x";
    expect(closeStreamingMarkdown(text)).toBe(text);
  });
});
