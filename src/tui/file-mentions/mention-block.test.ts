import { describe, expect, it } from "vitest";
import {
  appendMentionBlock,
  collapseMentionedFiles,
  describeMentionedFile,
  splitMentionedFiles,
  typedTextOf,
  type MentionedFile,
} from "./mention-block.js";

const small: MentionedFile = { path: "src/app.ts", bytes: 12, content: "const a = 1;" };
const cut: MentionedFile = { path: "big.log", bytes: 200_000, content: "head", truncatedTo: 32 * 1024 };
const binary: MentionedFile = { path: "logo.png", bytes: 4096, content: "", skipped: "binary file" };

describe("appendMentionBlock", () => {
  it("leaves the text alone when there are no files", () => {
    expect(appendMentionBlock("hello", [])).toBe("hello");
  });

  it("puts the typed text first and each file in its own tagged section", () => {
    const out = appendMentionBlock("explain @src/app.ts", [small]);
    expect(out.startsWith("explain @src/app.ts\n\n<mentioned-files>\n")).toBe(true);
    expect(out).toContain('<file path="src/app.ts">\nconst a = 1;\n</file>');
    expect(out.endsWith("</mentioned-files>")).toBe(true);
  });

  it("states a truncation in the message itself", () => {
    const out = appendMentionBlock("see @big.log", [cut]);
    expect(out).toContain("[truncated: showing the first 32 KB of 195 KB");
    expect(describeMentionedFile(cut)).toBe("big.log (195 KB, truncated to the first 32 KB)");
  });

  it("lists a skipped file without a content section", () => {
    const out = appendMentionBlock("see @logo.png", [binary]);
    expect(out).toContain("- logo.png (4 KB, not inlined: binary file)");
    expect(out).not.toContain('<file path="logo.png">');
  });
});

describe("splitMentionedFiles / collapse", () => {
  const message = appendMentionBlock("compare @src/app.ts and @big.log", [small, cut]);

  it("recovers the typed text and one summary line per file", () => {
    expect(splitMentionedFiles(message)).toEqual({
      typed: "compare @src/app.ts and @big.log",
      files: ["src/app.ts (12 B)", "big.log (195 KB, truncated to the first 32 KB)"],
    });
  });

  it("folds the block to one line per file for the chat bubble", () => {
    expect(collapseMentionedFiles(message)).toBe(
      "compare @src/app.ts and @big.log\n  + src/app.ts (12 B)\n  + big.log (195 KB, truncated to the first 32 KB)",
    );
  });

  it("gives input history only what was typed", () => {
    expect(typedTextOf(message)).toBe("compare @src/app.ts and @big.log");
  });

  it("does not touch a message without a block", () => {
    expect(splitMentionedFiles("plain")).toBeNull();
    expect(collapseMentionedFiles("plain")).toBe("plain");
    expect(typedTextOf("plain")).toBe("plain");
  });
});
