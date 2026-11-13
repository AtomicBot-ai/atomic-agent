import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  cleanDescription,
  fieldNoteFromBlockDoc,
  GENERATED_MODULE,
  REFERENCE_DOC,
  renderAll,
} from "./gen-settings-reference.js";

describe("cleanDescription", () => {
  it("keeps the first paragraph, unwraps links, drops schema-history notes", () => {
    expect(
      cleanDescription("Where reads may go (config v67). See {@link ReadScope}.\n\nMaintainer notes."),
    ).toBe("Where reads may go. See ReadScope.");
  });

  it("cuts a long paragraph at a sentence end", () => {
    const long = `${"word ".repeat(60)}end. ${"more ".repeat(60)}`;
    const cleaned = cleanDescription(long);
    expect(cleaned.endsWith("end.")).toBe(true);
  });
});

describe("fieldNoteFromBlockDoc", () => {
  const block = [
    "Link graph. Default enabled.",
    "",
    " - `enabled`            master switch.",
    " - `expansionDepth`     BFS depth on recall.",
    "                        Clamped to [1, 3].",
    "",
    "`taps` (added in config v30) holds GitHub repositories.",
  ].join("\n");

  it("reads a bullet and its continuation lines", () => {
    expect(fieldNoteFromBlockDoc(block, "expansionDepth")).toBe("BFS depth on recall. Clamped to [1, 3].");
    expect(fieldNoteFromBlockDoc(block, "enabled")).toBe("Master switch.");
  });

  it("reads a paragraph that opens with the field name", () => {
    expect(fieldNoteFromBlockDoc(block, "taps")).toBe("Holds GitHub repositories.");
  });

  it("is empty when the block does not mention the field", () => {
    expect(fieldNoteFromBlockDoc(block, "missing")).toBe("");
  });
});

describe("generated settings reference", () => {
  // Builds a TypeScript program over src/config, so it is slower than a unit test.
  it("is up to date with the schema's JSDoc", () => {
    const { module, markdown } = renderAll();
    const hint = "run `npx tsx scripts/gen-settings-reference.ts`";
    expect(readFileSync(GENERATED_MODULE, "utf8"), hint).toBe(module);
    expect(readFileSync(REFERENCE_DOC, "utf8"), hint).toBe(markdown);
  }, 120_000);
});
