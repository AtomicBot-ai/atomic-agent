import { describe, expect, it } from "vitest";

import {
  REWRITTEN_QUERY_MAX_LENGTH,
  parseRewriterOutput,
} from "./query-rewriter-parser.js";

describe("parseRewriterOutput", () => {
  it("extracts the body from a well-formed envelope", () => {
    expect(
      parseRewriterOutput("<rewritten_query>FTS5 ranking algorithm</rewritten_query>"),
    ).toBe("FTS5 ranking algorithm");
  });

  it("trims surrounding whitespace and trailing newline", () => {
    expect(
      parseRewriterOutput("<rewritten_query>  hi there  </rewritten_query>\n"),
    ).toBe("hi there");
  });

  it("returns null on the abstain token NONE", () => {
    expect(
      parseRewriterOutput("<rewritten_query>NONE</rewritten_query>"),
    ).toBeNull();
  });

  it("returns null when the envelope is missing", () => {
    expect(parseRewriterOutput("plain raw output")).toBeNull();
    expect(parseRewriterOutput("<other_tag>x</other_tag>")).toBeNull();
  });

  it("returns null on empty body", () => {
    expect(parseRewriterOutput("<rewritten_query></rewritten_query>")).toBeNull();
    expect(
      parseRewriterOutput("<rewritten_query>   </rewritten_query>"),
    ).toBeNull();
  });

  it("clamps an oversized body to REWRITTEN_QUERY_MAX_LENGTH", () => {
    const huge = "x".repeat(REWRITTEN_QUERY_MAX_LENGTH + 50);
    const out = parseRewriterOutput(`<rewritten_query>${huge}</rewritten_query>`);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(REWRITTEN_QUERY_MAX_LENGTH);
  });

  it("rejects multi-line bodies (defensive — grammar already forbids \\n)", () => {
    expect(
      parseRewriterOutput(
        "<rewritten_query>line one\nline two</rewritten_query>",
      ),
    ).toBeNull();
  });

  it("survives a CRLF terminator", () => {
    expect(
      parseRewriterOutput("<rewritten_query>x</rewritten_query>\r\n"),
    ).toBe("x");
  });
});
