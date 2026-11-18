import { describe, expect, it } from "vitest";

import { citeFor, fileUrlFor, formatTimestamp } from "./file-cite.js";

describe("citeFor: the link the model pastes as is (contract w6-memory-files)", () => {
  it("cites a PDF page with the open-parameters fragment", () => {
    expect(citeFor({ path: "/Users/me/Docs/report.pdf", page: 12 })).toBe(
      "[report.pdf, p. 12](file:///Users/me/Docs/report.pdf#page=12)",
    );
  });

  it("cites a time in seconds with the media fragment and m:ss in the label", () => {
    expect(citeFor({ path: "/Users/me/Audio/call.m4a", timeSec: 83.7 })).toBe(
      "[call.m4a, 1:23](file:///Users/me/Audio/call.m4a#t=83)",
    );
  });

  it("cites any other file without a fragment", () => {
    expect(citeFor({ path: "/Users/me/Docs/notes.md" })).toBe("[notes.md](file:///Users/me/Docs/notes.md)");
  });

  it("percent-encodes the path: spaces, hash, question mark, parentheses and brackets", () => {
    const cite = citeFor({ path: "/Users/me/My Docs/Q&A #2 (final) [v3]?.pdf", page: 1 });
    expect(cite).toBe(
      "[Q&A #2 (final) \\[v3\\]?.pdf, p. 1](file:///Users/me/My%20Docs/Q&A%20%232%20%28final%29%20%5Bv3%5D%3F.pdf#page=1)",
    );
    // The URL part decodes back to the path.
    const url = cite.slice(cite.indexOf("](") + 2, cite.lastIndexOf("#"));
    expect(decodeURIComponent(new URL(url).pathname)).toBe("/Users/me/My Docs/Q&A #2 (final) [v3]?.pdf");
  });

  it("keeps non-ASCII names readable in the label and encoded in the URL", () => {
    const cite = citeFor({ path: "/Users/me/Документы/отчёт.pdf", page: 3 });
    expect(cite.startsWith("[отчёт.pdf, p. 3](file:///Users/me/")).toBe(true);
    expect(cite).toContain("%D0%");
    expect(cite.endsWith("#page=3)")).toBe(true);
  });

  it("a page wins over a time, and a bad page or time falls back to the plain link", () => {
    expect(citeFor({ path: "/a/b.pdf", page: 2, timeSec: 9 })).toBe("[b.pdf, p. 2](file:///a/b.pdf#page=2)");
    expect(citeFor({ path: "/a/b.pdf", page: 0 })).toBe("[b.pdf](file:///a/b.pdf)");
    expect(citeFor({ path: "/a/b.m4a", timeSec: Number.NaN })).toBe("[b.m4a](file:///a/b.m4a)");
  });

  it("formats hours when the time passes one", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(59)).toBe("0:59");
    expect(formatTimestamp(3723)).toBe("1:02:03");
  });

  it("fileUrlFor escapes the markdown link breakers only", () => {
    expect(fileUrlFor("/x/a(b).txt")).toBe("file:///x/a%28b%29.txt");
  });
});
