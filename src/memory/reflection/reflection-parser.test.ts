import { describe, expect, it } from "vitest";

import { parseReflectionOutput } from "./reflection-parser.js";

describe("parseReflectionOutput", () => {
  it("returns kind=none for the literal NONE", () => {
    expect(parseReflectionOutput("NONE")).toEqual({ kind: "none", facts: [] });
    expect(parseReflectionOutput("NONE\n")).toEqual({ kind: "none", facts: [] });
    expect(parseReflectionOutput("  NONE  \n")).toEqual({
      kind: "none",
      facts: [],
    });
  });

  it("returns kind=none for empty output", () => {
    expect(parseReflectionOutput("")).toEqual({ kind: "none", facts: [] });
    expect(parseReflectionOutput("   \n\n")).toEqual({ kind: "none", facts: [] });
  });

  it("parses a single SET line", () => {
    const result = parseReflectionOutput("SET name=Alex\n");
    expect(result).toEqual({
      kind: "facts",
      facts: [{ key: "name", value: "Alex" }],
    });
  });

  it("parses multiple SET lines", () => {
    const result = parseReflectionOutput(
      "SET name=Alex\nSET timezone=Europe/Lisbon\nSET hobby=running\n",
    );
    expect(result.kind).toBe("facts");
    expect(result.facts).toEqual([
      { key: "name", value: "Alex" },
      { key: "timezone", value: "Europe/Lisbon" },
      { key: "hobby", value: "running" },
    ]);
  });

  it("preserves `=` inside values", () => {
    const result = parseReflectionOutput("SET equation=a=b+c\n");
    expect(result.facts).toEqual([{ key: "equation", value: "a=b+c" }]);
  });

  it("deduplicates keys keeping the last value", () => {
    const result = parseReflectionOutput(
      "SET name=Alex\nSET name=Alexandra\n",
    );
    expect(result.facts).toEqual([{ key: "name", value: "Alexandra" }]);
  });

  it("skips malformed lines", () => {
    const result = parseReflectionOutput(
      "gibberish\nSET name=Alex\nSET =empty\nSET novalue=\nSET ok=fine\n",
    );
    expect(result.facts).toEqual([
      { key: "name", value: "Alex" },
      { key: "ok", value: "fine" },
    ]);
  });

  it("tolerates CRLF line endings", () => {
    const result = parseReflectionOutput("SET a=1\r\nSET b=2\r\n");
    expect(result.facts).toEqual([
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ]);
  });

  it("returns kind=none when every line is malformed", () => {
    expect(parseReflectionOutput("definitely not a SET line\n")).toEqual({
      kind: "none",
      facts: [],
    });
  });
});
