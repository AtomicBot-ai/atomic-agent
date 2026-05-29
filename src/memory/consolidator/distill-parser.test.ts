import { describe, expect, it } from "vitest";

import {
  DistillParseError,
  parseDistillOutput,
} from "./distill-parser.js";

describe("parseDistillOutput", () => {
  it("parses a well-formed LESSON line with all fields", () => {
    const out = parseDistillOutput(
      `LESSON activation="When asked about pnpm"; principle="Always use pnpm install over npm install."; tags=tool,pnpm\n`,
    );
    expect(out).toEqual({
      kind: "lesson",
      activation: "When asked about pnpm",
      principle: "Always use pnpm install over npm install.",
      tags: ["tool", "pnpm"],
    });
  });

  it("parses a LESSON line without tags", () => {
    const out = parseDistillOutput(
      `LESSON activation="When debugging flake"; principle="Re-run with headless=false."\n`,
    );
    expect(out).toEqual({
      kind: "lesson",
      activation: "When debugging flake",
      principle: "Re-run with headless=false.",
      tags: [],
    });
  });

  it("returns kind=none on the explicit abstain sentinel", () => {
    const out = parseDistillOutput(
      `LESSON activation="(no consensus)"; principle="(no durable advice)"\n`,
    );
    expect(out).toEqual({ kind: "none" });
  });

  it("throws on empty input", () => {
    expect(() => parseDistillOutput("")).toThrow(DistillParseError);
    expect(() => parseDistillOutput("   ")).toThrow(DistillParseError);
  });

  it("throws when there is no LESSON line", () => {
    expect(() =>
      parseDistillOutput("some prose without a LESSON tag"),
    ).toThrow(DistillParseError);
  });

  it("throws on missing activation / principle", () => {
    expect(() =>
      parseDistillOutput(`LESSON principle="ok"`),
    ).toThrow(DistillParseError);
    expect(() =>
      parseDistillOutput(`LESSON activation="ok"`),
    ).toThrow(DistillParseError);
  });

  it("throws on oversized activation", () => {
    const big = "x".repeat(300);
    expect(() =>
      parseDistillOutput(
        `LESSON activation="${big}"; principle="ok"\n`,
      ),
    ).toThrow(DistillParseError);
  });

  it("drops malformed tags but keeps the lesson", () => {
    const out = parseDistillOutput(
      `LESSON activation="a"; principle="p"; tags=ok,!bad,fine\n`,
    );
    expect(out).toMatchObject({
      kind: "lesson",
      activation: "a",
      principle: "p",
      // `!bad` regex-rejected via `!`; only `ok` and `fine` survive.
      tags: ["ok", "fine"],
    });
  });

  it("ignores leading non-LESSON lines and picks the first LESSON match", () => {
    const out = parseDistillOutput(
      [
        "# preamble that should be ignored",
        "",
        `LESSON activation="a"; principle="p"`,
        "trailing garbage",
      ].join("\n"),
    );
    expect(out).toEqual({
      kind: "lesson",
      activation: "a",
      principle: "p",
      tags: [],
    });
  });

  describe("JSON shape (cloud Structured Outputs)", () => {
    it("parses { kind: 'none' } as the abstain branch", () => {
      const out = parseDistillOutput(JSON.stringify({ kind: "none" }));
      expect(out).toEqual({ kind: "none" });
    });

    it("parses a well-formed lesson payload with tags", () => {
      const out = parseDistillOutput(
        JSON.stringify({
          kind: "lesson",
          activation: "When asked about pnpm",
          principle: "Always use pnpm install over npm install.",
          tags: ["tool", "pnpm"],
        }),
      );
      expect(out).toEqual({
        kind: "lesson",
        activation: "When asked about pnpm",
        principle: "Always use pnpm install over npm install.",
        tags: ["tool", "pnpm"],
      });
    });

    it("treats the sentinel abstain on JSON path same as kind=none", () => {
      const out = parseDistillOutput(
        JSON.stringify({
          kind: "lesson",
          activation: "(no consensus)",
          principle: "(no durable advice)",
          tags: [],
        }),
      );
      expect(out).toEqual({ kind: "none" });
    });

    it("throws DistillParseError on JSON with empty activation", () => {
      expect(() =>
        parseDistillOutput(
          JSON.stringify({
            kind: "lesson",
            activation: "",
            principle: "p",
            tags: [],
          }),
        ),
      ).toThrow(DistillParseError);
    });

    it("drops invalid / oversized / non-string tags on JSON path", () => {
      const out = parseDistillOutput(
        JSON.stringify({
          kind: "lesson",
          activation: "a",
          principle: "p",
          tags: ["valid", "BAD-CASE", "", 42, "x".repeat(200), "valid"],
        }),
      );
      expect(out).toEqual({
        kind: "lesson",
        activation: "a",
        principle: "p",
        tags: ["valid"],
      });
    });

    it("falls back to text-grammar parser when JSON shape is wrong", () => {
      // body starts with `{`, JSON.parse succeeds, but `kind` is
      // missing → JSON branch returns null. The text branch then
      // looks for a LESSON line and finds none → throws.
      expect(() =>
        parseDistillOutput(JSON.stringify({ foo: "bar" })),
      ).toThrow(DistillParseError);
    });
  });
});
