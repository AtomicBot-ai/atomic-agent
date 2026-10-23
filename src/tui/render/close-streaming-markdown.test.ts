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

  it("handles a *** run as ** plus * on both ends", () => {
    expect(closeStreamingMarkdown("hello ***")).toBe("hello ");
    expect(closeStreamingMarkdown("***bi*** more text")).toBe("***bi*** more text");
    expect(closeStreamingMarkdown("***a* b")).toBe("***a* b**");
  });

  it("does not read a closed code fence above as markup", () => {
    // The blank line inside the block puts the code into the last block;
    // `*args` and the closing ``` must not be "closed" after `Done`.
    const head = "```py\ndef f():\n\n    return f(*args, **kw)\n```\n";
    expect(closeStreamingMarkdown(`${head}Done`)).toBe(`${head}Done`);
    expect(closeStreamingMarkdown(`${head}Done **x`)).toBe(`${head}Done **x**`);
  });

  it("does not touch the inside of an open code fence", () => {
    const text = "Here:\n\n```js\nconst a = '**';\nconst b = `x";
    expect(closeStreamingMarkdown(text)).toBe(text);
  });
});
