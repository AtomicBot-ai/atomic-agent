import { describe, expect, it } from "vitest";
import { foldTypography, unescapeText } from "./fs-edit-folding.js";
import {
  findTolerantEditMatch,
  tolerantAmbiguityMessage,
  tolerantMatchNote,
  type EditMatchLevel,
} from "./fs-edit-tolerant.js";

/** The level that matched and the file after the edit. */
function edit(
  source: string,
  oldString: string,
  newString: string,
): { level: EditMatchLevel; after: string } {
  const lookup = findTolerantEditMatch(source, oldString, newString);
  if (lookup.kind !== "unique") throw new Error(`expected unique, got ${JSON.stringify(lookup)}`);
  const { start, end } = lookup.match;
  return {
    level: lookup.level,
    after: source.slice(0, start) + lookup.replacement + source.slice(end),
  };
}

describe("findTolerantEditMatch, one level at a time", () => {
  it("whitespace: blank lines and trailing spaces (the ATO-785 level, first)", () => {
    expect(edit("a = 1  \n\nb = 2\n", "a = 1\nb = 2", "a = 1\nb = 3")).toEqual({
      level: "whitespace",
      after: "a = 1\nb = 3\n",
    });
  });

  it("boundary: stray whitespace around a part of a line, trimmed from both strings", () => {
    expect(edit("if (ready) start();\n", " start(); ", " stop(); ")).toEqual({
      level: "boundary",
      after: "if (ready) stop();\n",
    });
  });

  it("boundary: trimmed text must still sit on whitespace where oldString had some", () => {
    expect(findTolerantEditMatch("yx = 1\n", "  x = 1", "  x = 2").kind).toBe("none");
  });

  it("indentation: the whole block shifted; newString is shifted by the same amount", () => {
    const source = "def f():\n        if x:\n            go()\n";
    expect(edit(source, "    if x:\n        go()", "    if y:\n        go()")).toEqual({
      level: "indentation",
      after: "def f():\n        if y:\n            go()\n",
    });
  });

  it("line-trim: each line's indentation differs", () => {
    expect(edit("items:\n  - a\n  - b\n", "items:\n- a\n- b", "items:\n- a\n- c")).toEqual({
      level: "line-trim",
      after: "items:\n- a\n- c\n",
    });
  });

  it("inner-whitespace: runs of spaces inside a line", () => {
    expect(
      edit("const total =   price *  qty;\n", "const total = price * qty;", "const total = price * qty * 2;"),
    ).toEqual({ level: "inner-whitespace", after: "const total = price * qty * 2;\n" });
  });

  it("escapes: oldString written with \\n where the file has a line break", () => {
    expect(edit("first line\nsecond line\n", "first line\\nsecond line", "first line\nthird line")).toEqual({
      level: "escapes",
      after: "first line\nthird line\n",
    });
  });

  it('escapes: the file holds \\" where oldString has a plain quote', () => {
    expect(edit('log("say \\"hi\\"");\n', 'log("say "hi"");', 'log("say \\"bye\\"");')).toEqual({
      level: "escapes",
      after: 'log("say \\"bye\\"");\n',
    });
  });

  it("typography: curly quotes and an en dash in the file, ASCII in oldString", () => {
    const source = "title = \u201cHello\u201d \u2013 world\nnext\n";
    expect(edit(source, 'title = "Hello" - world', 'title = "Bye" - world')).toEqual({
      level: "typography",
      after: 'title = "Bye" - world\nnext\n',
    });
  });

  it("typography: a curly apostrophe on an indented line", () => {
    const source = "  msg = 'it\u2019s fine'\n";
    expect(edit(source, "msg = 'it's fine'", "msg = 'all good'").level).toBe("typography");
  });

  it("block-anchor: first and last lines match, one middle line retyped", () => {
    const source =
      "function total(items) {\n  let sum = 0;\n  for (const item of items) sum += item.price;\n  return sum;\n}\n";
    const oldString =
      "function total(items) {\n  let sum = 0;\n  for (const item of items) sum += item.cost;\n  return sum;\n}";
    const newString = "function total(items) {\n  return items.length;\n}";
    expect(edit(source, oldString, newString)).toEqual({
      level: "block-anchor",
      after: "function total(items) {\n  return items.length;\n}\n",
    });
  });

  it("block-anchor: a middle that differs too much is no match", () => {
    const source = "begin\nalpha beta gamma\nend\n";
    expect(findTolerantEditMatch(source, "begin\nsomething else entirely\nend", "x").kind).toBe("none");
  });
});

describe("findTolerantEditMatch, re-indenting on the indentation level", () => {
  it("shifts a Python-like block, keeping blank lines and added lines in step", () => {
    const source = "class A:\n    def f(self):\n        if x:\n            go()\n";
    const lookup = findTolerantEditMatch(source, "if x:\n    go()", "if x:\n    go()\n\n    log()\nreturn 1");
    expect(lookup).toMatchObject({ kind: "unique", level: "indentation", reindented: true });
    expect(edit(source, "if x:\n    go()", "if x:\n    go()\n\n    log()\nreturn 1").after).toBe(
      "class A:\n    def f(self):\n        if x:\n            go()\n\n            log()\n        return 1\n",
    );
  });

  it("uses the file's tabs where the model indented with spaces", () => {
    expect(edit("def f():\n\ta = 1\n\tb = 2\n", "    a = 1\n    b = 2", "    a = 1\n    b = 3")).toEqual({
      level: "indentation",
      after: "def f():\n\ta = 1\n\tb = 3\n",
    });
  });

  it("adds the file's outer tab when the model dropped it", () => {
    const source = "def f():\n\tif x:\n\t\tgo()\n";
    expect(edit(source, "if x:\n\tgo()", "if y:\n\tstop()").after).toBe(
      "def f():\n\tif y:\n\t\tstop()\n",
    );
  });

  it("inserts newString as sent when one of its lines is less indented than the shift removes", () => {
    const source = "def f():\n        if x:\n            go()\n";
    const lookup = findTolerantEditMatch(source, "    if x:\n        go()", "    if x:\n        go()\nprint(1)");
    expect(lookup).toMatchObject({ kind: "unique", level: "indentation", reindented: false });
    expect(edit(source, "    if x:\n        go()", "    if x:\n        go()\nprint(1)").after).toBe(
      "def f():\n    if x:\n        go()\nprint(1)\n",
    );
  });

  it("line-trim does not re-indent", () => {
    expect(findTolerantEditMatch("items:\n  - a\n  - b\n", "items:\n- a\n- b", "x")).toMatchObject({
      level: "line-trim",
      reindented: false,
    });
  });
});

describe("findTolerantEditMatch, safety rules", () => {
  it("refuses an ambiguous level and does not look further", () => {
    const source = "if x:\n    go()\nif x:\n        go()\n";
    expect(findTolerantEditMatch(source, "if x:\ngo()", "if y:\ngo()")).toEqual({
      kind: "ambiguous",
      level: "line-trim",
      count: 2,
    });
  });

  it("refuses two blocks with the same anchors, whatever their middles", () => {
    const block = (body: string) => `fn() {\n  ${body}\n}\n`;
    const source = block("one();") + block("two();");
    expect(findTolerantEditMatch(source, "fn() {\n  three();\n}", "x")).toMatchObject({
      kind: "ambiguous",
      level: "block-anchor",
    });
  });

  it("refuses a span far longer than oldString", () => {
    expect(findTolerantEditMatch("a\n\n\n\n\n\nb\n", "a\nb", "c").kind).toBe("none");
  });

  it("keeps a CRLF file CRLF when an LF oldString matches with drifted indentation", () => {
    const source = "def f():\r\n        return 1\r\n";
    expect(edit(source, "def f():\n    return 1", "def f():\n    return 2")).toEqual({
      level: "line-trim",
      after: "def f():\r\n    return 2\r\n",
    });
  });

  it("finds nothing when no level can explain the difference", () => {
    expect(findTolerantEditMatch("alpha\n", "beta", "gamma").kind).toBe("none");
  });
});

describe("notes and messages", () => {
  it("names the level that matched, with a caution where newString may need it", () => {
    expect(tolerantMatchNote("whitespace")).toBe(
      "note: oldString was not found exactly; it matched one place once blank lines and trailing spaces were ignored, and the edit was applied there. Check the diff.",
    );
    expect(tolerantMatchNote("inner-whitespace")).toContain("every run of whitespace was treated as one space");
    expect(tolerantMatchNote("indentation")).toContain("check its indentation");
    expect(tolerantMatchNote("indentation", true)).toContain("shifted by the same indentation");
    expect(tolerantMatchNote("typography")).toContain("curly quotes");
  });

  it("says how many places an ambiguous level fits", () => {
    expect(tolerantAmbiguityMessage("line-trim", 3)).toMatch(/matches 3 places, so nothing was changed/);
  });
});

describe("folding helpers", () => {
  it("folds typography one unit for one, so offsets carry over", () => {
    const text = "\u2018a\u2019 \u201cb\u201d c\u2014d\u00a0e\u2212f";
    expect(foldTypography(text)).toBe(`'a' "b" c-d e-f`);
    expect(foldTypography(text)).toHaveLength(text.length);
  });

  it("resolves the usual backslash escapes and leaves others alone", () => {
    expect(unescapeText("a\\nb\\tc\\\"d\\\\e\\q")).toBe('a\nb\tc"d\\e\\q');
  });
});
