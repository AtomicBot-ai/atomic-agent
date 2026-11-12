import { describe, expect, it } from "vitest";
import { isOutboundCall } from "./outbound-calls.js";

describe("isOutboundCall", () => {
  it("flags tools that send, push or post", () => {
    for (const tool of ["os.email.send", "os.git.push", "github.pr.create", "github.issue.comment", "browser.click"]) {
      expect(isOutboundCall({ tool, args: {} }), tool).toBe(true);
    }
  });

  it("keeps local reads and writes", () => {
    for (const tool of ["os.fs.read", "os.fs.write", "os.git.commit", "os.web.fetch", "memory.notes.recall"]) {
      expect(isOutboundCall({ tool, args: {} }), tool).toBe(false);
    }
  });

  it("flags a writing HTTP method and keeps a GET", () => {
    expect(isOutboundCall({ tool: "os.http.request", args: { method: "POST", url: "https://x.test" } })).toBe(true);
    expect(isOutboundCall({ tool: "os.http.request", args: { method: "get", url: "https://x.test" } })).toBe(false);
    expect(isOutboundCall({ tool: "os.http.request", args: { url: "https://x.test" } })).toBe(false);
  });

  it("reads the shell command from cmd and args", () => {
    expect(isOutboundCall({ tool: "os.shell.run", args: { cmd: "git push origin main" } })).toBe(true);
    expect(isOutboundCall({ tool: "os.shell.run", args: { cmd: "git", args: ["push", "-u", "origin", "x"] } })).toBe(true);
    expect(isOutboundCall({ tool: "os.shell.run", args: { cmd: ["gh", "pr", "create"] } })).toBe(true);
    expect(isOutboundCall({ tool: "os.shell.run", args: { cmd: "curl -X POST https://x.test" } })).toBe(true);
    expect(isOutboundCall({ tool: "os.shell.run", args: { cmd: "curl -s https://x.test | head" } })).toBe(false);
    expect(isOutboundCall({ tool: "os.shell.run", args: { cmd: "git status" } })).toBe(false);
    expect(isOutboundCall({ tool: "os.shell.run", args: { cmd: "ls", args: ["-la"] } })).toBe(false);
  });

  it("keeps a reading MCP tool and flags a writing or unclear one", () => {
    expect(isOutboundCall({ tool: "mcp.notion.search", args: {} })).toBe(false);
    expect(isOutboundCall({ tool: "mcp.composio.GMAIL_FETCH_EMAILS", args: {} })).toBe(false);
    expect(isOutboundCall({ tool: "mcp.resource.read", args: {} })).toBe(false);
    expect(isOutboundCall({ tool: "mcp.composio.GMAIL_SEND_EMAIL", args: {} })).toBe(true);
    expect(isOutboundCall({ tool: "mcp.slack.chat_post_message", args: {} })).toBe(true);
    expect(isOutboundCall({ tool: "mcp.gcal.create_event", args: {} })).toBe(true);
    expect(isOutboundCall({ tool: "mcp.x.y", args: {} })).toBe(true);
  });

  it("flags a call whose approval was for publishing or mail", () => {
    expect(isOutboundCall({ tool: "skill.run_script", args: {}, approvalCategories: ["publish"] })).toBe(true);
    expect(isOutboundCall({ tool: "os.fs.write", args: {}, approvalCategories: ["fs_write_workspace"] })).toBe(false);
  });
});
