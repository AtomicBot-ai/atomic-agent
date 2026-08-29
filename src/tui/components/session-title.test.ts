import { describe, expect, it } from "vitest";

import { sessionTitleLine } from "./session-title.js";

describe("sessionTitleLine", () => {
  it("collapses a multi-line prompt into one line", () => {
    expect(sessionTitleLine("ONE\none\n1\n1\n1\n1\n1", 32)).toBe(
      "ONE one 1 1 1 1 1",
    );
  });

  it("collapses CRLF, tabs and runs of blank lines too", () => {
    expect(sessionTitleLine("first\r\n\r\n\tsecond", 32)).toBe("first second");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sessionTitleLine("\n\n  hello  \n\n", 32)).toBe("hello");
  });

  it("keeps a line that exactly fills the width", () => {
    const exact = "x".repeat(32);
    expect(sessionTitleLine(exact, 32)).toBe(exact);
  });

  it("ellipsises one cell early so the mark fits inside the width", () => {
    const long = "x".repeat(40);
    const title = sessionTitleLine(long, 32);
    expect(title).toHaveLength(32);
    expect(title.endsWith("…")).toBe(true);
  });

  it("measures the collapsed length, not the raw one", () => {
    // Ten cells of newline are worth nine cells of text once collapsed,
    // so this fits and must not be cut.
    expect(sessionTitleLine("a\n\n\n\n\n\n\n\n\n\nb", 5)).toBe("a b");
  });

  it("returns empty for a preview that is only whitespace", () => {
    expect(sessionTitleLine("\n \t\n", 32)).toBe("");
  });

  it("returns empty when there is no room to draw", () => {
    expect(sessionTitleLine("something", 0)).toBe("");
  });
});
