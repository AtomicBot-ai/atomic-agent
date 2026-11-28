import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../approval/index.js";

import {
  sessionGrantLabels,
  sessionGrantOffer,
  sessionGrantScope,
  sessionGrantSummary,
} from "./approval-session-grants.js";
import { sessionGrantFinalText, sessionGrantRows } from "./telegram/approval-grant-buttons.js";

// The one source of the "Allow ... this session" offer that Telegram,
// Discord, Slack and Microsoft Teams share (ATO-2509).

function shellReq(commandShape?: string): ApprovalRequest {
  return {
    approvalId: "abc",
    sessionId: "s-1",
    tool: "os.shell.run",
    category: "shell",
    reason: "run git",
    preview: "git push origin main",
    ...(commandShape !== undefined ? { commandShape } : {}),
  };
}

describe("sessionGrantOffer", () => {
  it("offers the kind and the shape for an ordinary shell command", () => {
    expect(sessionGrantOffer(shellReq("git"))).toEqual({ category: "shell command", shape: "git", shell: true });
  });

  it("offers nothing for a category that is never granted", () => {
    expect(sessionGrantOffer({ ...shellReq("rm"), category: "shell_dangerous" })).toBeNull();
    expect(sessionGrantOffer({ ...shellReq(), tool: "trust.config.write", category: "trust_config" })).toBeNull();
  });
});

describe("sessionGrantLabels", () => {
  it("uses the TUI's words and cuts long labels to 60 characters", () => {
    expect(sessionGrantLabels({ category: "shell command", shape: "git", shell: true })).toEqual({
      category: "Allow shell command this session",
      shape: "Allow all git this session",
    });
    const long = sessionGrantLabels({ shape: "x".repeat(200), shell: true }).shape!;
    expect(long).toHaveLength(60);
    expect(long.endsWith("…")).toBe(true);
    expect(sessionGrantLabels(null)).toEqual({});
  });
});

describe("sessionGrantScope and sessionGrantSummary", () => {
  it("maps a click to its scope only when that grant was offered", () => {
    const offer = { category: "shell command", shell: true };
    expect(sessionGrantScope("s", offer)).toBe("category");
    expect(sessionGrantScope("a", offer)).toBeNull();
    expect(sessionGrantScope("s", undefined)).toBeNull();
  });

  it("notes that risky commands still ask after a shell grant", () => {
    expect(sessionGrantSummary("shape", { shape: "git", shell: true })).toBe(
      "all git commands (risky commands still ask)",
    );
    expect(sessionGrantSummary("category", { category: "web request to example.com", shell: false })).toBe(
      "web request to example.com",
    );
  });
});

describe("Telegram keeps its wire form on the shared source", () => {
  it("builds the same rows and final text as before the move", () => {
    const offer = sessionGrantOffer(shellReq("git"));
    expect(sessionGrantRows("appr:", "abc", offer)).toEqual([
      [{ text: "Allow shell command this session", callback_data: "appr:abc:s" }],
      [{ text: "Allow all git this session", callback_data: "appr:abc:a" }],
    ]);
    expect(sessionGrantFinalText("category", offer!)).toBe(
      "✅ approved · allowed this session: shell command (risky commands still ask)",
    );
  });
});
