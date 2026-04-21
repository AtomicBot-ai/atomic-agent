import { describe, expect, it } from "vitest";
import { createDocExtractor } from "./doc-extractor.js";

describe("docExtractor (via createDocExtractor)", () => {
  it("passes the buffer through a temp file to the client and unwraps body text", async () => {
    let calledPath: string | undefined;
    let cleanedUp = false;
    const extractor = createDocExtractor(
      async () => ({
        async extract(filePath: string) {
          calledPath = filePath;
          return {
            getBody: () => "First line.\r\n\r\nSecond line.",
          };
        },
      }),
      async (data) => ({
        path: `/tmp/fake-${data.length}.doc`,
        cleanup: async () => {
          cleanedUp = true;
        },
      }),
    );

    const result = await extractor({
      data: Buffer.from("FAKE DOC BYTES"),
      sourcePath: "/ignored/path.doc",
    });

    expect(result.format).toBe("doc");
    expect(result.text).toBe("First line.\n\nSecond line.");
    expect(calledPath).toBe("/tmp/fake-14.doc");
    expect(cleanedUp).toBe(true);
  });

  it("normalises Windows line endings and collapses >2 newlines", async () => {
    const extractor = createDocExtractor(
      async () => ({
        async extract() {
          return {
            getBody: () => "A\r\n\r\n\r\n\r\nB\rC\nD",
          };
        },
      }),
      async () => ({ path: "/tmp/x.doc", cleanup: async () => undefined }),
    );
    const result = await extractor({
      data: Buffer.from(""),
      sourcePath: "/x.doc",
    });
    expect(result.text).toBe("A\n\nB\nC\nD");
  });

  it("cleans up the temp file even if extraction throws", async () => {
    let cleanedUp = false;
    const extractor = createDocExtractor(
      async () => ({
        async extract() {
          throw new Error("parse failed");
        },
      }),
      async () => ({
        path: "/tmp/err.doc",
        cleanup: async () => {
          cleanedUp = true;
        },
      }),
    );
    await expect(
      extractor({ data: Buffer.from(""), sourcePath: "/x.doc" }),
    ).rejects.toThrow(/parse failed/);
    expect(cleanedUp).toBe(true);
  });
});
