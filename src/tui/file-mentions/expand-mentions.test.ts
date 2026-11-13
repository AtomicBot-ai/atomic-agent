import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandFileMentions, mentionTokens, resolveMentionedFile } from "./expand-mentions.js";
import { splitMentionedFiles } from "./mention-block.js";

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mentions-"));
  root = join(base, "project");
  outside = join(base, "secret.txt");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const app = 1;\n");
  writeFileSync(join(root, "README.md"), "# Readme\n");
  writeFileSync(outside, "do not read\n");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("mentionTokens", () => {
  it("collects distinct @words that start a word", () => {
    expect(mentionTokens("see @a.ts, @b.ts and @a.ts; mail x@y.z")).toEqual(["a.ts,", "b.ts", "a.ts;"]);
  });
});

describe("expandFileMentions", () => {
  it("inlines a mentioned file under the typed text", () => {
    const out = expandFileMentions("explain @src/app.ts", root);
    expect(out.startsWith("explain @src/app.ts\n\n<mentioned-files>")).toBe(true);
    expect(out).toContain('<file path="src/app.ts">\nexport const app = 1;\n</file>');
  });

  it("leaves a message without file mentions unchanged", () => {
    expect(expandFileMentions("ping @team about @missing.ts and @src", root)).toBe(
      "ping @team about @missing.ts and @src",
    );
  });

  it("drops trailing punctuation when the bare path is the file", () => {
    const out = expandFileMentions("open @README.md.", root);
    expect(splitMentionedFiles(out)?.files).toEqual(["README.md (9 B)"]);
  });

  it("never reads a path outside the working directory", () => {
    expect(expandFileMentions("cat @../secret.txt", root)).toBe("cat @../secret.txt");
    expect(expandFileMentions(`cat @${outside}`, root)).toBe(`cat @${outside}`);
  });

  it("refuses a symlink inside the folder that points out of it", () => {
    symlinkSync(outside, join(root, "link.txt"));
    expect(resolveMentionedFile(root, "link.txt")).toBeNull();
    expect(expandFileMentions("cat @link.txt", root)).toBe("cat @link.txt");
  });

  it("cuts a large file and says so", () => {
    writeFileSync(join(root, "big.log"), "x".repeat(5000));
    const out = expandFileMentions("tail @big.log", root, { fileBytes: 1024, totalBytes: 10_000, files: 8 });
    expect(out).toContain("[truncated: showing the first 1 KB of 5 KB");
    expect(out).not.toContain("x".repeat(1025));
  });

  it("lists a binary file without inlining it", () => {
    writeFileSync(join(root, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const out = expandFileMentions("what is @blob.bin", root);
    expect(splitMentionedFiles(out)?.files).toEqual(["blob.bin (4 B, not inlined: binary file)"]);
  });

  it("stops inlining once the message budget is spent", () => {
    writeFileSync(join(root, "a.txt"), "a".repeat(600));
    writeFileSync(join(root, "b.txt"), "b".repeat(600));
    const out = expandFileMentions("@a.txt @b.txt", root, { fileBytes: 1000, totalBytes: 600, files: 8 });
    expect(splitMentionedFiles(out)?.files).toEqual([
      "a.txt (600 B)",
      "b.txt (600 B, not inlined: the message's file budget is used up)",
    ]);
  });

  it("caps the number of files", () => {
    const out = expandFileMentions("@README.md @src/app.ts", root, { fileBytes: 1000, totalBytes: 10_000, files: 1 });
    expect(splitMentionedFiles(out)?.files).toEqual(["README.md (9 B)"]);
  });
});
