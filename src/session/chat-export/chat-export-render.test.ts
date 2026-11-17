import { describe, expect, it } from "vitest";

import {
  buildChatExport,
  markdownToHtml,
  renderChatHtml,
  renderChatMarkdown,
} from "./chat-export-render.js";

const ctx = { homeDir: "/Users/nadya", workingDir: "/Users/nadya/shop", knownSecrets: [] };
const exportedAt = new Date("2026-11-12T10:00:00Z");

function chat(lines: { kind: "user" | "assistant_reply"; text: string }[], title = "Fix the cart") {
  return buildChatExport({ title, lines, exportedAt, appVersion: "0.7.1" }, ctx);
}

describe("buildChatExport", () => {
  it("maps kinds to roles, redacts and drops empty messages", () => {
    const built = chat([
      { kind: "user", text: "fix /Users/nadya/shop/src/cart.ts" },
      { kind: "assistant_reply", text: "<think>hmm</think>" },
      { kind: "assistant_reply", text: "Fixed <project>." },
    ]);
    expect(built.messages).toEqual([
      { role: "user", text: "fix <project>/src/cart.ts" },
      { role: "assistant", text: "Fixed <project>." },
    ]);
    expect(built.counts.paths).toBe(1);
    expect(built.counts.reasoning).toBe(1);
  });

  it("redacts the title and falls back when it is empty", () => {
    expect(chat([], "notes for a@b.io").title).toBe("notes for [email]");
    expect(chat([], "   ").title).toBe("Chat");
  });
});

describe("renderChatHtml", () => {
  it("is one page with no script and a CSP that allows none", () => {
    const html = renderChatHtml(chat([{ kind: "user", text: "hi" }]));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/(?:src|href)=["']https?:/i);
  });

  it("escapes message text so HTML in a reply is shown, not run", () => {
    const html = renderChatHtml(
      chat([{ kind: "assistant_reply", text: '<img src=x onerror="alert(1)"><script>x()</script>' }]),
    );
    expect(html).not.toContain("<script>x()");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes the title", () => {
    const html = renderChatHtml(chat([], "</title><script>1</script>"));
    expect(html).toContain("<title>&lt;/title&gt;&lt;script&gt;1&lt;/script&gt;</title>");
  });

  it("labels who spoke and says what was left out", () => {
    const html = renderChatHtml(
      chat([
        { kind: "user", text: "q" },
        { kind: "assistant_reply", text: "a" },
      ]),
    );
    expect(html).toContain('<section class="msg user"><h2>You</h2>');
    expect(html).toContain('<section class="msg assistant"><h2>Atomic Agent</h2>');
    expect(html).toContain("Shared from Atomic Agent 0.7.1 on 2026-11-12");
  });
});

describe("markdownToHtml", () => {
  it("renders fenced code, inline code, bold and line breaks", () => {
    expect(markdownToHtml("Run **this**:\n```sh\nnpm test <x>\n```\nthen `git push`\nok")).toBe(
      [
        "<p>Run <strong>this</strong>:</p>",
        "<pre><code>npm test &lt;x&gt;</code></pre>",
        "<p>then <code>git push</code><br>ok</p>",
      ].join("\n"),
    );
  });

  it("keeps links as text", () => {
    expect(markdownToHtml("[click](https://evil.example)")).toBe(
      "<p>[click](https://evil.example)</p>",
    );
  });
});

describe("renderChatMarkdown", () => {
  it("writes a heading per message and the footer", () => {
    const md = renderChatMarkdown(
      chat([
        { kind: "user", text: "q" },
        { kind: "assistant_reply", text: "a" },
      ]),
    );
    expect(md).toBe(
      [
        "# Fix the cart",
        "",
        "## You",
        "",
        "q",
        "",
        "## Atomic Agent",
        "",
        "a",
        "",
        "---",
        "",
        "Shared from Atomic Agent 0.7.1 on 2026-11-12. Messages only: tool output, reasoning and local paths were removed.",
        "",
      ].join("\n"),
    );
  });
});
