import { describe, expect, it } from "vitest";
import { plainTextExtractor } from "./plain-text-extractor.js";

describe("plainTextExtractor", () => {
  it("returns UTF-8 content as-is", async () => {
    const result = await plainTextExtractor({
      data: Buffer.from("hello world", "utf8"),
      sourcePath: "/tmp/x.txt",
    });
    expect(result.format).toBe("plain");
    expect(result.text).toBe("hello world");
    expect(result.warnings).toEqual([]);
  });

  it("normalises CRLF and lone CR into LF", async () => {
    const result = await plainTextExtractor({
      data: Buffer.from("a\r\nb\rc\n", "utf8"),
      sourcePath: "/tmp/x.txt",
    });
    expect(result.text).toBe("a\nb\nc\n");
  });

  it("falls back to latin1 when UTF-8 produces replacement chars", async () => {
    // byte 0xE9 ("é" in latin1) is invalid as a standalone UTF-8 start byte
    const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "café" in latin1
    const result = await plainTextExtractor({
      data: latin,
      sourcePath: "/tmp/x.txt",
    });
    expect(result.text).toBe("café");
    expect(result.warnings[0]).toMatch(/latin1 fallback/);
  });

  it("preserves unicode text that IS valid UTF-8", async () => {
    const result = await plainTextExtractor({
      data: Buffer.from("каф\u00e9 — omnissiah", "utf8"),
      sourcePath: "/tmp/x.txt",
    });
    expect(result.text).toBe("каф\u00e9 — omnissiah");
    expect(result.warnings).toEqual([]);
  });
});
