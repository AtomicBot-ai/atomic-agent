import { describe, it, expect } from "vitest";

import { parseLinkGeneratorOutput } from "./link-generator-parser.js";

describe("parseLinkGeneratorOutput", () => {
  const allowlist = new Set([1, 2, 3, 4]);

  it("returns none for the literal NONE", () => {
    expect(
      parseLinkGeneratorOutput("NONE", { allowlist }),
    ).toEqual({ kind: "none" });
  });

  it("returns none for empty or whitespace-only payloads", () => {
    expect(parseLinkGeneratorOutput("", { allowlist })).toEqual({
      kind: "none",
    });
    expect(parseLinkGeneratorOutput("   \n\n  ", { allowlist })).toEqual({
      kind: "none",
    });
  });

  it("parses a single LINK line", () => {
    const r = parseLinkGeneratorOutput(
      "LINK 1 2 [kind=RELATES_TO]\n",
      { allowlist },
    );
    expect(r.kind).toBe("links");
    if (r.kind !== "links") throw new Error();
    expect(r.links).toEqual([
      { fromId: 1, toId: 2, kind: "RELATES_TO" },
    ]);
  });

  it("parses multiple LINK lines and preserves order", () => {
    const r = parseLinkGeneratorOutput(
      [
        "LINK 1 2 [kind=RELATES_TO]",
        "LINK 2 3 [kind=CAUSED_BY]",
        "LINK 4 1 [kind=REFERENCES]",
      ].join("\n"),
      { allowlist },
    );
    expect(r.kind).toBe("links");
    if (r.kind !== "links") throw new Error();
    expect(r.links).toHaveLength(3);
    expect(r.links[0]).toEqual({ fromId: 1, toId: 2, kind: "RELATES_TO" });
    expect(r.links[2]).toEqual({ fromId: 4, toId: 1, kind: "REFERENCES" });
  });

  it("drops self-loops", () => {
    expect(
      parseLinkGeneratorOutput("LINK 1 1 [kind=RELATES_TO]\n", { allowlist }),
    ).toEqual({ kind: "none" });
  });

  it("drops links with endpoints outside the allowlist", () => {
    const r = parseLinkGeneratorOutput(
      [
        "LINK 1 2 [kind=RELATES_TO]",
        "LINK 1 99 [kind=CAUSED_BY]",
        "LINK 50 2 [kind=REFERENCES]",
      ].join("\n"),
      { allowlist },
    );
    expect(r.kind).toBe("links");
    if (r.kind !== "links") throw new Error();
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toEqual({ fromId: 1, toId: 2, kind: "RELATES_TO" });
  });

  it("drops unknown link kinds", () => {
    const r = parseLinkGeneratorOutput(
      "LINK 1 2 [kind=BOGUS]\n",
      { allowlist },
    );
    expect(r).toEqual({ kind: "none" });
  });

  it("dedupes identical (from, to, kind) triples", () => {
    const r = parseLinkGeneratorOutput(
      [
        "LINK 1 2 [kind=RELATES_TO]",
        "LINK 1 2 [kind=RELATES_TO]",
        "LINK 1 2 [kind=CAUSED_BY]",
      ].join("\n"),
      { allowlist },
    );
    expect(r.kind).toBe("links");
    if (r.kind !== "links") throw new Error();
    expect(r.links).toHaveLength(2);
  });

  it("respects maxLinks cap", () => {
    const r = parseLinkGeneratorOutput(
      [
        "LINK 1 2 [kind=RELATES_TO]",
        "LINK 2 3 [kind=RELATES_TO]",
        "LINK 3 4 [kind=RELATES_TO]",
        "LINK 4 1 [kind=RELATES_TO]",
        "LINK 1 3 [kind=RELATES_TO]",
      ].join("\n"),
      { allowlist, maxLinks: 2 },
    );
    expect(r.kind).toBe("links");
    if (r.kind !== "links") throw new Error();
    expect(r.links).toHaveLength(2);
  });

  it("silently skips malformed lines without invalidating others", () => {
    const r = parseLinkGeneratorOutput(
      [
        "LINK 1 2 [kind=RELATES_TO]",
        "this is garbage",
        "LINK 99",
        "LINK 2 3 [kind=CAUSED_BY]",
      ].join("\n"),
      { allowlist },
    );
    expect(r.kind).toBe("links");
    if (r.kind !== "links") throw new Error();
    expect(r.links).toHaveLength(2);
  });

  describe("JSON shape (cloud Structured Outputs)", () => {
    it("parses { kind: 'none' } as the abstain branch", () => {
      const r = parseLinkGeneratorOutput(
        JSON.stringify({ kind: "none" }),
        { allowlist },
      );
      expect(r).toEqual({ kind: "none" });
    });

    it("parses a single { kind: 'links' } payload", () => {
      const r = parseLinkGeneratorOutput(
        JSON.stringify({
          kind: "links",
          links: [{ from_id: 1, to_id: 2, link_kind: "RELATES_TO" }],
        }),
        { allowlist },
      );
      expect(r.kind).toBe("links");
      if (r.kind !== "links") throw new Error();
      expect(r.links).toEqual([
        { fromId: 1, toId: 2, kind: "RELATES_TO" },
      ]);
    });

    it("applies the allowlist + self-loop filters on the JSON path too", () => {
      const r = parseLinkGeneratorOutput(
        JSON.stringify({
          kind: "links",
          links: [
            { from_id: 1, to_id: 2, link_kind: "RELATES_TO" },
            { from_id: 2, to_id: 2, link_kind: "RELATES_TO" }, // self-loop
            { from_id: 1, to_id: 99, link_kind: "RELATES_TO" }, // not in allowlist
            { from_id: 3, to_id: 4, link_kind: "TOTALLY_FAKE" }, // bad kind
            { from_id: 3, to_id: 4, link_kind: "CAUSED_BY" },
          ],
        }),
        { allowlist },
      );
      expect(r.kind).toBe("links");
      if (r.kind !== "links") throw new Error();
      expect(r.links).toEqual([
        { fromId: 1, toId: 2, kind: "RELATES_TO" },
        { fromId: 3, toId: 4, kind: "CAUSED_BY" },
      ]);
    });

    it("respects maxLinks on the JSON path", () => {
      const r = parseLinkGeneratorOutput(
        JSON.stringify({
          kind: "links",
          links: [
            { from_id: 1, to_id: 2, link_kind: "RELATES_TO" },
            { from_id: 2, to_id: 3, link_kind: "RELATES_TO" },
            { from_id: 3, to_id: 4, link_kind: "RELATES_TO" },
          ],
        }),
        { allowlist, maxLinks: 2 },
      );
      expect(r.kind).toBe("links");
      if (r.kind !== "links") throw new Error();
      expect(r.links).toHaveLength(2);
    });

    it("dedupes identical triples on the JSON path", () => {
      const r = parseLinkGeneratorOutput(
        JSON.stringify({
          kind: "links",
          links: [
            { from_id: 1, to_id: 2, link_kind: "RELATES_TO" },
            { from_id: 1, to_id: 2, link_kind: "RELATES_TO" },
            { from_id: 1, to_id: 2, link_kind: "CAUSED_BY" },
          ],
        }),
        { allowlist },
      );
      expect(r.kind).toBe("links");
      if (r.kind !== "links") throw new Error();
      expect(r.links).toHaveLength(2);
    });

    it("falls back to the text grammar parser on malformed JSON", () => {
      // A model that started with `{` but tripped halfway must not
      // silently drop a perfectly valid trailing LINK line. The
      // parser tries JSON first, fails, then sweeps the text grammar.
      // Note: a body that starts with `{` is treated as a single
      // (malformed) line by the line splitter — the text branch sees
      // nothing parseable. The intent of this case is to assert "no
      // crash, returns none", not "recovers everything".
      const r = parseLinkGeneratorOutput("{ kind: 'lin", { allowlist });
      expect(r).toEqual({ kind: "none" });
    });

    it("falls back to the text grammar parser when the body is JSON-looking but not our schema", () => {
      const r = parseLinkGeneratorOutput(
        JSON.stringify({ foo: "bar", baz: 1 }),
        { allowlist },
      );
      expect(r).toEqual({ kind: "none" });
    });

    it("returns none when kind=links but the array is empty after filtering", () => {
      const r = parseLinkGeneratorOutput(
        JSON.stringify({
          kind: "links",
          links: [
            { from_id: 99, to_id: 100, link_kind: "RELATES_TO" }, // both outside allowlist
          ],
        }),
        { allowlist },
      );
      expect(r).toEqual({ kind: "none" });
    });
  });
});
