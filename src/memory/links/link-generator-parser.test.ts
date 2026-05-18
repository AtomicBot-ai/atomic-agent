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
});
