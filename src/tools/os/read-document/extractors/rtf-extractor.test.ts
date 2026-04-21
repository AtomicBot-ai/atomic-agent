import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { rtfExtractor } from "./rtf-extractor.js";

const FIXTURE_PATH = resolve(
  new URL("../../test-fixtures/sample.rtf", import.meta.url).pathname,
);

describe("rtfExtractor", () => {
  it("extracts plain text from a simple RTF fixture", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await rtfExtractor({ data, sourcePath: FIXTURE_PATH });
    expect(result.format).toBe("rtf");
    expect(result.text).toContain("Sample RTF document");
    expect(result.text).toContain("magos approves");
    expect(result.text).toContain("omnissiah vult");
  });

  it("strips ignorable destinations like \\fonttbl", async () => {
    const rtf = Buffer.from(
      "{\\rtf1\\ansi{\\fonttbl{\\f0\\fnil Calibri;}{\\f1\\fnil Arial;}}Real text here.\\par}",
      "utf8",
    );
    const result = await rtfExtractor({ data: rtf, sourcePath: "inline.rtf" });
    expect(result.text).toBe("Real text here.");
    expect(result.text).not.toContain("Calibri");
    expect(result.text).not.toContain("Arial");
  });

  it("skips `{\\*\\generator ...}` metadata groups", async () => {
    const rtf = Buffer.from(
      "{\\rtf1\\ansi{\\*\\generator Riza 4.0;}Keep me.\\par}",
      "utf8",
    );
    const result = await rtfExtractor({ data: rtf, sourcePath: "inline.rtf" });
    expect(result.text).toBe("Keep me.");
  });

  it("translates control words to whitespace/punctuation", async () => {
    const rtf = Buffer.from(
      "{\\rtf1\\ansi A\\par B\\tab C\\emdash D\\par}",
      "utf8",
    );
    const result = await rtfExtractor({ data: rtf, sourcePath: "inline.rtf" });
    expect(result.text).toBe("A\nB\tC\u2014D");
  });

  it("decodes \\'hh escapes from CP1252", async () => {
    // \'e9 = é (U+00E9) identical in cp1252 and latin1
    // \'97 = em-dash U+2014 (cp1252-specific; in pure latin1 it's a control char)
    const rtf = Buffer.from("{\\rtf1\\ansi caf\\'e9 \\'97 end\\par}", "utf8");
    const result = await rtfExtractor({ data: rtf, sourcePath: "inline.rtf" });
    expect(result.text).toBe("café \u2014 end");
  });

  it("decodes \\uNNNN Unicode escapes", async () => {
    const rtf = Buffer.from(
      "{\\rtf1\\ansi \\u1054?\\u1084?\\u1085?\\u1080?\\u1089?\\u1089?\\u1080?\\u1072?\\u1093?\\par}",
      "utf8",
    );
    const result = await rtfExtractor({ data: rtf, sourcePath: "inline.rtf" });
    expect(result.text).toContain("Омниссиах");
  });
});
