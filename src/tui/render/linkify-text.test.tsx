import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { LinkifiedText, splitUrlSegments } from "./linkify-text.js";

describe("splitUrlSegments", () => {
  it("returns an empty list for empty input", () => {
    expect(splitUrlSegments("")).toEqual([]);
  });

  it("returns a single inert segment when there is no URL", () => {
    expect(splitUrlSegments("just plain text")).toEqual([
      { text: "just plain text", url: null },
    ]);
  });

  it("isolates a URL surrounded by prose", () => {
    expect(splitUrlSegments("see https://cursor.com now")).toEqual([
      { text: "see ", url: null },
      { text: "https://cursor.com", url: "https://cursor.com" },
      { text: " now", url: null },
    ]);
  });

  it("trims trailing sentence punctuation out of the URL", () => {
    expect(splitUrlSegments("open https://cursor.com.")).toEqual([
      { text: "open ", url: null },
      { text: "https://cursor.com", url: "https://cursor.com" },
      { text: ".", url: null },
    ]);
  });

  it("detects multiple URLs in one line", () => {
    const segments = splitUrlSegments("http://a.io and http://b.io");
    expect(segments.filter((s) => s.url !== null).map((s) => s.url)).toEqual([
      "http://a.io",
      "http://b.io",
    ]);
  });
});

describe("LinkifiedText", () => {
  it("wraps a bare URL in OSC 8 while keeping it visible", () => {
    const { lastFrame } = render(
      <Text>
        <LinkifiedText text="go https://cursor.com" />
      </Text>,
    );
    const text = lastFrame() ?? "";
    expect(text).toContain(
      "\u001b]8;;https://cursor.com\u001b\\https://cursor.com\u001b]8;;\u001b\\",
    );
  });

  it("renders plain text without any OSC 8 escape", () => {
    const { lastFrame } = render(
      <Text>
        <LinkifiedText text="no links here" />
      </Text>,
    );
    const text = lastFrame() ?? "";
    expect(text).toContain("no links here");
    expect(text).not.toContain("\u001b]8;;");
  });
});
