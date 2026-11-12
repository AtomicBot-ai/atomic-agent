import { describe, expect, it } from "vitest";

import { formatMatrixMessage, formatMatrixNotice, markdownToMatrixHtml } from "./matrix-format.js";

describe("formatMatrixMessage", () => {
  it("sends plain text without formatted_body", () => {
    expect(formatMatrixMessage("hello there")).toEqual({ msgtype: "m.text", body: "hello there" });
  });

  it("adds HTML for markdown and keeps the markdown as body", () => {
    const content = formatMatrixMessage("**done** with `ls`");
    expect(content.body).toBe("**done** with `ls`");
    expect(content.format).toBe("org.matrix.custom.html");
    expect(content.formatted_body).toContain("<b>done</b>");
    expect(content.formatted_body).toContain("<code>ls</code>");
  });

  it("escapes raw HTML in the text", () => {
    const content = formatMatrixMessage("<script>alert(1)</script>");
    expect(content.formatted_body).not.toContain("<script>");
    expect(content.formatted_body).toContain("&lt;script&gt;");
  });
});

describe("markdownToMatrixHtml", () => {
  it("turns newlines into <br> outside code blocks only", () => {
    const html = markdownToMatrixHtml("one\ntwo\n\n```\na\nb\n```");
    expect(html).toContain("one<br>two");
    expect(html).toMatch(/<pre><code>a\nb\n?<\/code><\/pre>/);
  });
});

describe("formatMatrixNotice", () => {
  it("is a plain m.notice", () => {
    expect(formatMatrixNotice("hi")).toEqual({ msgtype: "m.notice", body: "hi" });
  });
});
