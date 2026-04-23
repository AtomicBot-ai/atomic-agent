import { describe, expect, it } from "vitest";

import { parseReflectionOutput } from "./reflection-parser.js";

const pinnedFact = (key: string, value: string) => ({
  key,
  value,
  pinned: true,
  keywords: [],
});

describe("parseReflectionOutput", () => {
  it("returns kind=none for the literal NONE", () => {
    expect(parseReflectionOutput("NONE")).toEqual({
      kind: "none",
      facts: [],
      notes: [],
    });
    expect(parseReflectionOutput("NONE\n")).toEqual({
      kind: "none",
      facts: [],
      notes: [],
    });
    expect(parseReflectionOutput("  NONE  \n")).toEqual({
      kind: "none",
      facts: [],
      notes: [],
    });
  });

  it("returns kind=none for empty output", () => {
    expect(parseReflectionOutput("")).toEqual({
      kind: "none",
      facts: [],
      notes: [],
    });
    expect(parseReflectionOutput("   \n\n")).toEqual({
      kind: "none",
      facts: [],
      notes: [],
    });
  });

  it("parses a single SET line", () => {
    const result = parseReflectionOutput("SET name=Alex\n");
    expect(result).toEqual({
      kind: "facts",
      facts: [pinnedFact("name", "Alex")],
      notes: [],
    });
  });

  it("parses multiple SET lines", () => {
    const result = parseReflectionOutput(
      "SET name=Alex\nSET timezone=Europe/Lisbon\nSET hobby=running\n",
    );
    expect(result.kind).toBe("facts");
    expect(result.facts).toEqual([
      pinnedFact("name", "Alex"),
      pinnedFact("timezone", "Europe/Lisbon"),
      pinnedFact("hobby", "running"),
    ]);
  });

  it("preserves `=` inside values", () => {
    const result = parseReflectionOutput("SET equation=a=b+c\n");
    expect(result.facts).toEqual([pinnedFact("equation", "a=b+c")]);
  });

  it("deduplicates keys keeping the last value", () => {
    const result = parseReflectionOutput(
      "SET name=Alex\nSET name=Alexandra\n",
    );
    expect(result.facts).toEqual([pinnedFact("name", "Alexandra")]);
  });

  it("skips malformed lines", () => {
    const result = parseReflectionOutput(
      "gibberish\nSET name=Alex\nSET =empty\nSET novalue=\nSET ok=fine\n",
    );
    expect(result.facts).toEqual([
      pinnedFact("name", "Alex"),
      pinnedFact("ok", "fine"),
    ]);
  });

  it("tolerates CRLF line endings", () => {
    const result = parseReflectionOutput("SET a=1\r\nSET b=2\r\n");
    expect(result.facts).toEqual([
      pinnedFact("a", "1"),
      pinnedFact("b", "2"),
    ]);
  });

  it("recognises the [pinned=false; keywords=...] marker on a SET line", () => {
    const result = parseReflectionOutput(
      "SET deploy_cmd=pnpm run deploy [pinned=false; keywords=deploy,release,ship]\n",
    );
    expect(result.facts).toEqual([
      {
        key: "deploy_cmd",
        value: "pnpm run deploy",
        pinned: false,
        keywords: ["deploy", "release", "ship"],
      },
    ]);
  });

  it("accepts the SET marker separated by a comma instead of semicolon", () => {
    const result = parseReflectionOutput(
      "SET deploy_cmd=pnpm run deploy [pinned=false, keywords=deploy]\n",
    );
    expect(result.facts).toEqual([
      {
        key: "deploy_cmd",
        value: "pnpm run deploy",
        pinned: false,
        keywords: ["deploy"],
      },
    ]);
  });

  it("ignores the SET marker when pinned!=false (falls back to pinned=true)", () => {
    const result = parseReflectionOutput(
      "SET language=ru [pinned=true; keywords=lang]\n",
    );
    expect(result.facts).toEqual([pinnedFact("language", "ru")]);
  });

  it("does not mistake a [tags=...] marker at the end of a SET value for the SET marker", () => {
    const result = parseReflectionOutput(
      "SET note=today [tags=foo]\n",
    );
    expect(result.facts).toEqual([
      { key: "note", value: "today [tags=foo]", pinned: true, keywords: [] },
    ]);
  });

  it("returns kind=none when every line is malformed", () => {
    expect(parseReflectionOutput("definitely not a SET line\n")).toEqual({
      kind: "none",
      facts: [],
      notes: [],
    });
  });

  it("parses a single NOTE line without tags", () => {
    const result = parseReflectionOutput(
      "NOTE user prefers inline code snippets over separate files\n",
    );
    expect(result).toEqual({
      kind: "facts",
      facts: [],
      notes: [
        {
          body: "user prefers inline code snippets over separate files",
          tags: [],
        },
      ],
    });
  });

  it("extracts trailing [tags=...] marker from a NOTE", () => {
    const result = parseReflectionOutput(
      "NOTE discovered project uses pnpm, not npm [tags=tooling,project-conventions]\n",
    );
    expect(result.notes).toEqual([
      {
        body: "discovered project uses pnpm, not npm",
        tags: ["tooling", "project-conventions"],
      },
    ]);
  });

  it("interleaves SET and NOTE lines preserving order within each channel", () => {
    const result = parseReflectionOutput(
      [
        "SET name=Alex",
        "NOTE trip to Lisbon planned for May",
        "SET timezone=Europe/Lisbon",
        "NOTE avoid confirming work on weekends [tags=preferences]",
      ].join("\n") + "\n",
    );
    expect(result.kind).toBe("facts");
    expect(result.facts).toEqual([
      pinnedFact("name", "Alex"),
      pinnedFact("timezone", "Europe/Lisbon"),
    ]);
    expect(result.notes).toEqual([
      { body: "trip to Lisbon planned for May", tags: [] },
      {
        body: "avoid confirming work on weekends",
        tags: ["preferences"],
      },
    ]);
  });

  it("drops invalid tag tokens and caps tag count", () => {
    const tagList = [
      "good",
      "UPPER",
      "has space",
      "too_long_tag_" + "x".repeat(60),
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
    ].join(",");
    const result = parseReflectionOutput(`NOTE some observation [tags=${tagList}]\n`);
    expect(result.notes[0]?.tags).toHaveLength(8);
    expect(result.notes[0]?.tags[0]).toBe("good");
    expect(result.notes[0]?.tags).not.toContain("UPPER");
    expect(result.notes[0]?.tags).not.toContain("has space");
  });

  it("clamps an oversized NOTE body to 500 chars", () => {
    const huge = "x".repeat(800);
    const result = parseReflectionOutput(`NOTE ${huge}\n`);
    expect(result.notes[0]?.body.length).toBe(500);
  });

  it("skips a NOTE with empty body after tag marker is stripped", () => {
    const result = parseReflectionOutput("NOTE  [tags=a]\n");
    expect(result).toEqual({ kind: "none", facts: [], notes: [] });
  });
});
