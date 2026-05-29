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

  describe("JSON shape (cloud Structured Outputs)", () => {
    it("extracts the rewritten_query field", () => {
      expect(
        parseRewriterOutput(
          JSON.stringify({ rewritten_query: "FTS5 ranking algorithm" }),
        ),
      ).toBe("FTS5 ranking algorithm");
    });

    it("trims whitespace inside the JSON value", () => {
      expect(
        parseRewriterOutput(
          JSON.stringify({ rewritten_query: "  hi there  " }),
        ),
      ).toBe("hi there");
    });

    it("returns null on the JSON-encoded abstain token", () => {
      expect(
        parseRewriterOutput(JSON.stringify({ rewritten_query: "NONE" })),
      ).toBeNull();
    });

    it("returns null on an empty / whitespace JSON value", () => {
      expect(
        parseRewriterOutput(JSON.stringify({ rewritten_query: "" })),
      ).toBeNull();
      expect(
        parseRewriterOutput(JSON.stringify({ rewritten_query: "   " })),
      ).toBeNull();
    });

    it("clamps oversized JSON values to REWRITTEN_QUERY_MAX_LENGTH", () => {
      const huge = "x".repeat(REWRITTEN_QUERY_MAX_LENGTH + 50);
      const out = parseRewriterOutput(
        JSON.stringify({ rewritten_query: huge }),
      );
      expect(out).not.toBeNull();
      expect(out!.length).toBe(REWRITTEN_QUERY_MAX_LENGTH);
    });

    it("rejects multi-line JSON values (matches grammar contract)", () => {
      expect(
        parseRewriterOutput(
          JSON.stringify({ rewritten_query: "line one\nline two" }),
        ),
      ).toBeNull();
    });

    it("falls back to the envelope parser when JSON has a different shape", () => {
      // The JSON branch returns `undefined` here (not its schema);
      // caller falls through to the envelope parser which sees no
      // <rewritten_query> tag and returns null.
      expect(parseRewriterOutput(JSON.stringify({ foo: "bar" }))).toBeNull();
    });

    it("falls back to the envelope parser when JSON is malformed", () => {
      // Starts with `{`, JSON.parse throws, falls through to envelope
      // parser, no envelope present → null.
      expect(parseRewriterOutput("{ rewritten_query: bad")).toBeNull();
    });

    it("when both formats coexist, the JSON branch wins on parseable JSON; otherwise envelope wins", () => {
      // Pure JSON body — JSON path wins.
      expect(
        parseRewriterOutput('{"rewritten_query":"json wins"}'),
      ).toBe("json wins");
      // Mixed body starting with `{` but JSON.parse fails on the
      // trailing envelope — falls through to the envelope parser
      // which extracts "envelope". This is intentional: we only
      // commit to the JSON path on a fully-parseable JSON body.
      const mixed = `{"rewritten_query":"json wins"}<rewritten_query>envelope</rewritten_query>`;
      expect(parseRewriterOutput(mixed)).toBe("envelope");
    });
  });
});
