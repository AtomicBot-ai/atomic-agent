import { describe, expect, it } from "vitest";

import {
  chatExportFilename,
  chatExportTitle,
  parseChatExportFormat,
  renderChatHtml,
  renderChatMarkdown,
} from "./chat-export.js";
import { createEmptySessionState, type SessionState } from "./session-state.js";
import type { ConversationTurn } from "./conversation-turn.js";

const NOW = Date.UTC(2026, 10, 12, 14, 3);

function chat(turns: ConversationTurn[], metadata: Record<string, unknown> = {}): SessionState {
  return {
    ...createEmptySessionState({ id: "s-export", workingDir: "/tmp/w" }),
    turns,
    metadata,
    createdAt: Date.UTC(2026, 10, 12, 13, 0),
  };
}

describe("chat export (ATO-1054)", () => {
  it("reads the short format names people type", () => {
    expect(parseChatExportFormat(undefined)).toBe("markdown");
    expect(parseChatExportFormat("MD")).toBe("markdown");
    expect(parseChatExportFormat("word")).toBe("docx");
    expect(parseChatExportFormat("htm")).toBe("html");
    expect(parseChatExportFormat("pdf")).toBeNull();
  });

  it("writes the conversation, one line per tool step, and leaves reasoning out", () => {
    const md = renderChatMarkdown(
      chat(
        [
          { kind: "user", text: "Read the notes", at: 1 },
          { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "a.md" }, reasoning: "secret plan", at: 2 },
          { kind: "tool_result", tool: "os.fs.read", status: "ok", summary: "RAW FILE BODY", at: 3 },
          { kind: "assistant_tool_call", tool: "os.shell.run", args: { cmd: "ls" }, at: 4 },
          { kind: "tool_result", tool: "os.shell.run", status: "error", summary: "boom", at: 5 },
          { kind: "assistant_reply", text: "Here is **the** summary.", reasoning: "thinking", attachments: ["/tmp/w/out.md"], at: 6 },
        ],
        { title: "Notes review" },
      ),
      { now: NOW },
    );
    expect(md).toContain("# Notes review");
    expect(md).toContain("Exported from Atomic Agent on 2026-11-12 14:03 UTC");
    expect(md).toContain("## You\n\nRead the notes");
    expect(md).toContain("## Atomic Agent\n\n- Used os.fs.read\n- Used os.shell.run (failed)\n\nHere is **the** summary.");
    expect(md).toContain("- `/tmp/w/out.md`");
    expect(md).not.toContain("secret plan");
    expect(md).not.toContain("thinking");
    expect(md).not.toContain("RAW FILE BODY");
    // One agent heading for the tool lines and the reply under them.
    expect(md.match(/## Atomic Agent/g)).toHaveLength(1);
  });

  it("uses the caller's words for tool steps and can leave them out", () => {
    const state = chat([
      { kind: "user", text: "hi", at: 1 },
      { kind: "assistant_tool_call", tool: "os.fs.read", args: {}, at: 2 },
      { kind: "tool_result", tool: "os.fs.read", status: "ok", summary: "", at: 3 },
      { kind: "assistant_reply", text: "done", at: 4 },
    ]);
    expect(renderChatMarkdown(state, { now: NOW, describeToolCall: ({ ok }) => `Read a file ${ok ? "ok" : "bad"}` }))
      .toContain("- Read a file ok");
    expect(renderChatMarkdown(state, { now: NOW, includeTools: false })).not.toContain("os.fs.read");
  });

  it("marks steered messages and stopped turns", () => {
    const md = renderChatMarkdown(
      chat([
        { kind: "user", text: "go", at: 1 },
        { kind: "user", text: "also this", steered: true, at: 2 },
        { kind: "assistant_reply", text: "", stopped: true, at: 3 },
      ]),
      { now: NOW },
    );
    expect(md).toContain("## You (sent while it was working)\n\nalso this");
    expect(md).toContain("_Stopped._");
  });

  it("names the chat after its title, else its first line, else its id", () => {
    expect(chatExportTitle(chat([], { title: "My chat" }))).toBe("My chat");
    expect(chatExportTitle(chat([{ kind: "user", text: "first line\nsecond", at: 1 }]))).toBe("first line");
    expect(chatExportTitle(chat([]))).toBe("Chat s-export");
  });

  it("makes a safe file name", () => {
    expect(chatExportFilename(chat([], { title: 'a/b:c*"d"?' }), "docx")).toBe("a b c d.docx");
    expect(chatExportFilename(chat([], { title: "..." }), "markdown")).toBe("chat-s-export.md");
    expect(chatExportFilename(chat([], { title: "x".repeat(200) }), "html")).toBe(`${"x".repeat(80)}.html`);
  });

  it("shows raw HTML and script links as text in the HTML export", () => {
    const html = renderChatHtml(
      "# T\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) and [good](https://example.com)\n\n![img](https://tracker.example/p.png)",
      "T <x>",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('<a href="https://example.com">good</a>');
    expect(html).not.toContain("<img");
    expect(html).toContain("<title>T &lt;x&gt;</title>");
    expect(html).toContain("default-src 'none'");
  });
});
