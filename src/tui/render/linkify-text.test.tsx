import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { hrefFor, LinkifiedText, splitUrlSegments } from "./linkify-text.js";

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

  it("detects a scheme-less www URL and normalises only the target", () => {
    expect(splitUrlSegments("try www.example.com today")).toEqual([
      { text: "try ", url: null },
      { text: "www.example.com", url: "https://www.example.com" },
      { text: " today", url: null },
    ]);
  });

  it("detects a www URL at the very start of the string", () => {
    expect(splitUrlSegments("www.a.io wins")[0]).toEqual({
      text: "www.a.io",
      url: "https://www.a.io",
    });
  });

  it("does not fire on a mid-word www run", () => {
    expect(splitUrlSegments("awww.cute but not a link")).toEqual([
      { text: "awww.cute but not a link", url: null },
    ]);
  });

  it("leaves a www that belongs to a larger hostname to its host", () => {
    // `www.` preceded by a dot is the middle of `api.www.host`, not a
    // link starting at `www.`.
    expect(
      splitUrlSegments("api.www.example.com").every((s) => s.url === null),
    ).toBe(true);
  });

  it("trims trailing punctuation off a www URL", () => {
    expect(splitUrlSegments("at www.example.com.")).toEqual([
      { text: "at ", url: null },
      { text: "www.example.com", url: "https://www.example.com" },
      { text: ".", url: null },
    ]);
  });

  it("does not link a bare www. that the trim leaves empty", () => {
    expect(
      splitUrlSegments("www.: not a link").every((s) => s.url === null),
    ).toBe(true);
  });
});

describe("hrefFor", () => {
  it("prefixes https onto a scheme-less www match", () => {
    expect(hrefFor("www.example.com")).toBe("https://www.example.com");
  });

  it("leaves scheme'd URLs untouched", () => {
    expect(hrefFor("https://example.com")).toBe("https://example.com");
    expect(hrefFor("http://www.example.com")).toBe("http://www.example.com");
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

  it("points a www link's OSC 8 target at https while showing the bare text", () => {
    const { lastFrame } = render(
      <Text>
        <LinkifiedText text="go www.example.com" />
      </Text>,
    );
    const text = lastFrame() ?? "";
    expect(text).toContain(
      "\u001b]8;;https://www.example.com\u001b\\www.example.com\u001b]8;;\u001b\\",
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
