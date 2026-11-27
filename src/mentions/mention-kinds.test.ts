import { describe, expect, it } from "vitest";
import { contextSuggestions, foldersOf, parseMentionKind } from "./mention-kinds.js";

describe("parseMentionKind", () => {
  it("tells diff, git:N, problems, ranges and links apart", () => {
    expect(parseMentionKind("diff")).toEqual({ kind: "diff" });
    expect(parseMentionKind("problems")).toEqual({ kind: "problems" });
    expect(parseMentionKind("git:4")).toEqual({ kind: "git", count: 4 });
    expect(parseMentionKind("git:99")).toEqual({ kind: "git", count: 20 });
    expect(parseMentionKind("git:0")).toBeNull();
    expect(parseMentionKind("src/a.ts:10-40")).toEqual({ kind: "range", path: "src/a.ts", start: 10, end: 40 });
    expect(parseMentionKind("src/a.ts:7")).toEqual({ kind: "range", path: "src/a.ts", start: 7, end: 7 });
    expect(parseMentionKind("a.ts#L10-L40")).toEqual({ kind: "range", path: "a.ts", start: 10, end: 40 });
    expect(parseMentionKind("a.ts:40-10")).toBeNull();
    expect(parseMentionKind("https://example.com/a?b=1")).toEqual({ kind: "url", url: "https://example.com/a?b=1" });
    expect(parseMentionKind("https://user:pw@host/")).toBeNull();
    for (const word of ["ftp://host/x", "file:///etc/hosts", "src/a.ts", "Diff", "Problems", "git"]) {
      expect(parseMentionKind(word), word).toBeNull();
    }
  });
});

describe("contextSuggestions", () => {
  it("offers the keywords for a prefix, problems included", () => {
    expect(contextSuggestions("")).toEqual([]);
    expect(contextSuggestions("d")).toEqual(["diff"]);
    expect(contextSuggestions("gi")).toEqual(["git:5"]);
    expect(contextSuggestions("pro")).toEqual(["problems"]);
    expect(contextSuggestions("P")).toEqual(["problems"]);
  });

  it("keeps a typed range, link, git:N or folder as typed", () => {
    expect(contextSuggestions("git:77")).toEqual(["git:20"]);
    expect(contextSuggestions("src/a.ts:10-40")).toEqual(["src/a.ts:10-40"]);
    expect(contextSuggestions("https://example.com/x")).toEqual(["https://example.com/x"]);
    expect(contextSuggestions("src/")).toEqual(["src/"]);
    expect(contextSuggestions("readme")).toEqual([]);
  });
});

describe("foldersOf", () => {
  it("lists each parent folder once, shallow first, with a trailing slash", () => {
    expect(foldersOf(["README.md", "src/a.ts", "src/tui/b.ts", "docs/x.md"])).toEqual(["docs/", "src/", "src/tui/"]);
  });

  it("stops at the cap", () => {
    expect(foldersOf(["a/x", "b/x", "c/x"], 2)).toHaveLength(2);
  });
});
