import { describe, expect, it } from "vitest";

import { escapeSlackText, markdownToSlack } from "./slack-format.js";

describe("markdownToSlack", () => {
  it("escapes control characters so a reply cannot ping the channel", () => {
    expect(markdownToSlack("hey <!channel> & <@U1>")).toBe("hey &lt;!channel&gt; &amp; &lt;@U1&gt;");
  });

  it("turns bold, strike, headings and bullets into mrkdwn", () => {
    expect(markdownToSlack("**done** ~~old~~")).toBe("*done* ~old~");
    expect(markdownToSlack("## Result")).toBe("*Result*");
    expect(markdownToSlack("- one\n- two")).toBe("• one\n• two");
  });

  it("rewrites links to <url|label>", () => {
    expect(markdownToSlack("see [the docs](https://example.com/a?b=1&c=2)")).toBe(
      "see <https://example.com/a?b=1&c=2|the docs>",
    );
  });

  it("leaves code untouched apart from escaping", () => {
    const md = "run `a **b** c` then\n```\nif (a < b) **x**\n```";
    expect(markdownToSlack(md)).toBe("run `a **b** c` then\n```\nif (a &lt; b) **x**\n```");
  });
});

describe("escapeSlackText", () => {
  it("escapes ampersand first", () => {
    expect(escapeSlackText("&lt;")).toBe("&amp;lt;");
  });
});
