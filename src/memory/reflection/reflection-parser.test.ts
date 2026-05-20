import { describe, expect, it } from "vitest";

import { parseReflectionOutput } from "./reflection-parser.js";

const pinnedFact = (key: string, value: string) => ({
  key,
  value,
  pinned: true,
  keywords: [],
  supersedes: null,
  validFrom: null,
});

describe("parseReflectionOutput", () => {
  it("returns kind=none for the literal NONE", () => {
    expect(parseReflectionOutput("NONE")).toEqual({
      kind: "none",
      facts: [],
      notes: [],
      evolves: [],
    });
    expect(parseReflectionOutput("NONE\n")).toEqual({
      kind: "none",
      facts: [],
      notes: [],
      evolves: [],
    });
    expect(parseReflectionOutput("  NONE  \n")).toEqual({
      kind: "none",
      facts: [],
      notes: [],
      evolves: [],
    });
  });

  it("returns kind=none for empty output", () => {
    expect(parseReflectionOutput("")).toEqual({
      kind: "none",
      facts: [],
      notes: [],
      evolves: [],
    });
    expect(parseReflectionOutput("   \n\n")).toEqual({
      kind: "none",
      facts: [],
      notes: [],
      evolves: [],
    });
  });

  it("parses a single SET line", () => {
    const result = parseReflectionOutput("SET name=Alex\n");
    expect(result).toEqual({
      kind: "facts",
      facts: [pinnedFact("name", "Alex")],
      notes: [],
      evolves: [],
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
        supersedes: null,
        validFrom: null,
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
        supersedes: null,
        validFrom: null,
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
      {
        key: "note",
        value: "today [tags=foo]",
        pinned: true,
        keywords: [],
        supersedes: null,
        validFrom: null,
      },
    ]);
  });

  it("returns kind=none when every line is malformed", () => {
    expect(parseReflectionOutput("definitely not a SET line\n")).toEqual({
      kind: "none",
      facts: [],
      notes: [],
      evolves: [],
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
      evolves: [],
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
    expect(result).toEqual({
      kind: "none",
      facts: [],
      notes: [],
      evolves: [],
    });
  });

  // Memory-v2 phase 3. EVOLVE coverage.

  it("parses a single EVOLVE line", () => {
    const result = parseReflectionOutput(
      "EVOLVE #42 [tags=browser,playwright,selectors]\n",
    );
    expect(result.kind).toBe("facts");
    expect(result.evolves).toEqual([
      { targetId: 42, addTags: ["browser", "playwright", "selectors"] },
    ]);
  });

  it("dedupes EVOLVE entries by targetId (last writer wins)", () => {
    const result = parseReflectionOutput(
      [
        "EVOLVE #5 [tags=alpha]",
        "EVOLVE #5 [tags=beta,gamma]",
      ].join("\n") + "\n",
    );
    expect(result.evolves).toEqual([
      { targetId: 5, addTags: ["beta", "gamma"] },
    ]);
  });

  it("drops EVOLVE with empty tag list", () => {
    const result = parseReflectionOutput("EVOLVE #1 [tags=]\n");
    expect(result.evolves).toEqual([]);
  });

  it("drops EVOLVE with non-positive id", () => {
    const result = parseReflectionOutput("EVOLVE #0 [tags=a]\n");
    expect(result.evolves).toEqual([]);
  });

  it("interleaves SET, NOTE, and EVOLVE preserving each channel", () => {
    const result = parseReflectionOutput(
      [
        "SET name=Alex",
        "NOTE trip planned",
        "EVOLVE #7 [tags=routing]",
        "SET tz=Europe/Lisbon",
      ].join("\n") + "\n",
    );
    expect(result.facts).toHaveLength(2);
    expect(result.notes).toHaveLength(1);
    expect(result.evolves).toEqual([
      { targetId: 7, addTags: ["routing"] },
    ]);
  });

  it("lower-cases EVOLVE tags and drops invalid tokens", () => {
    const result = parseReflectionOutput(
      "EVOLVE #1 [tags=Browser,UPPER_OK,has space,toolong" +
        "x".repeat(60) +
        ",good-tag]\n",
    );
    expect(result.evolves[0]?.addTags).toEqual([
      "browser",
      "upper_ok",
      "good-tag",
    ]);
  });

  // Memory-v2 phase 4. SET marker extensions: [valid_from=now;
  // supersedes=KEY] coexists with the existing [pinned=...;
  // keywords=...] clauses.

  it("parses a bare SET as a same-key auto-chain candidate (no supersedes)", () => {
    const result = parseReflectionOutput("SET language=ru\n");
    expect(result.facts).toEqual([
      {
        key: "language",
        value: "ru",
        pinned: true,
        keywords: [],
        supersedes: null,
        validFrom: null,
      },
    ]);
  });

  it("parses SET with [valid_from=now; supersedes=key] marker", () => {
    const result = parseReflectionOutput(
      "SET language=en [valid_from=now; supersedes=language]\n",
    );
    expect(result.facts).toEqual([
      {
        key: "language",
        value: "en",
        pinned: true,
        keywords: [],
        supersedes: "language",
        validFrom: "now",
      },
    ]);
  });

  it("parses cross-key supersedes hint", () => {
    const result = parseReflectionOutput(
      "SET full_name=Alex [supersedes=name]\n",
    );
    expect(result.facts[0]?.supersedes).toBe("name");
    expect(result.facts[0]?.validFrom).toBeNull();
  });

  it("combines pinned/keywords/supersedes inside one marker", () => {
    const result = parseReflectionOutput(
      "SET deploy_cmd=pnpm ship [pinned=false; keywords=deploy,ship; supersedes=deploy_cmd]\n",
    );
    expect(result.facts).toEqual([
      {
        key: "deploy_cmd",
        value: "pnpm ship",
        pinned: false,
        keywords: ["deploy", "ship"],
        supersedes: "deploy_cmd",
        validFrom: null,
      },
    ]);
  });

  it("drops a malformed supersedes RHS (rejects spaces and special chars)", () => {
    const result = parseReflectionOutput(
      "SET language=en [supersedes=not a valid key]\n",
    );
    expect(result.facts[0]?.supersedes).toBeNull();
  });

  it("drops a non-'now' valid_from RHS silently (runner always stamps the clock)", () => {
    const result = parseReflectionOutput(
      "SET language=en [valid_from=1970-01-01; supersedes=language]\n",
    );
    // valid_from rejected; supersedes still captured.
    expect(result.facts[0]?.validFrom).toBeNull();
    expect(result.facts[0]?.supersedes).toBe("language");
  });

  // --------------------------------------------------------------------------
  // Phase C: memU-inspired typed-NOTE extraction
  // --------------------------------------------------------------------------

  it("phase C: extracts [type=event] into a synthetic type:event tag", () => {
    const result = parseReflectionOutput(
      "NOTE [type=event] flew to Lisbon on 2025-12-12 for the offsite\n",
    );
    expect(result.notes).toEqual([
      {
        body: "flew to Lisbon on 2025-12-12 for the offsite",
        tags: ["type:event"],
      },
    ]);
  });

  it("phase C: extracts [type=behavior] / knowledge / skill", () => {
    const result = parseReflectionOutput(
      [
        "NOTE [type=behavior] deploys on Fridays via pnpm ship",
        "NOTE [type=knowledge] kubernetes pods can have init containers",
        "NOTE [type=skill] use ripgrep with --type ts to scope code search",
      ].join("\n"),
    );
    expect(result.notes.map((n) => n.tags[0])).toEqual([
      "type:behavior",
      "type:knowledge",
      "type:skill",
    ]);
  });

  it("phase C: merges type tag with trailing [tags=...] marker", () => {
    const result = parseReflectionOutput(
      "NOTE [type=event] launched v2.5 [tags=release,prod]\n",
    );
    expect(result.notes[0]).toEqual({
      body: "launched v2.5",
      tags: ["type:event", "release", "prod"],
    });
  });

  it("phase C: drops unknown [type=X] silently (body still kept)", () => {
    // Defensive parser path: even if a grammar regression let an
    // unknown type slip through (or a legacy session is replayed),
    // the parser fails closed on the tag namespace but does NOT drop
    // the body — the observation is still worth recalling.
    const result = parseReflectionOutput("NOTE [type=garbage] something happened\n");
    expect(result.notes).toEqual([
      { body: "something happened", tags: [] },
    ]);
  });

  it("phase C: legacy untyped NOTE keeps the existing behaviour (no type tag added)", () => {
    const result = parseReflectionOutput("NOTE plain old observation\n");
    expect(result.notes).toEqual([{ body: "plain old observation", tags: [] }]);
  });

  it("phase C: a malformed (no trailing space) marker degrades to body content", () => {
    // The parser only recognises the marker when followed by
    // whitespace (matches the grammar's `[type=X] ` production).
    // A truncated marker without trailing space falls through to
    // the body so the observation is not silently dropped — the
    // grammar prevents this shape in typed mode anyway.
    const result = parseReflectionOutput("NOTE [type=event]\n");
    expect(result.notes).toEqual([{ body: "[type=event]", tags: [] }]);
  });
});
