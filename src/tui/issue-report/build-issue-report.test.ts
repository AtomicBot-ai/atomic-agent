import { describe, expect, it } from "vitest";

import type { DebugBundleSnapshot } from "../debug-bundle/build-snapshot.js";
import { buildIssueReport, type IssueReportFacts } from "./build-issue-report.js";
import { renderSection } from "./issue-body.js";

const HOME = "/Users/valerii";
const CWD = `${HOME}/work/proj`;
const TOKEN = `ghp_${"A".repeat(36)}`;

const FACTS: IssueReportFacts = {
  version: "0.5.6",
  platform: "darwin",
  arch: "arm64",
  node: "v25.7.0",
  providerLabel: "openrouter",
  textModel: "qwen/qwen3",
  toolTransport: "native_tools",
  approvalLevel: 2,
  codingMode: "default",
  capturedAt: "2026-09-09T00:00:00.000Z",
};

function snapshot(): DebugBundleSnapshot {
  return {
    session: {
      sessionId: "sess-1",
      workingDir: CWD,
      llamaUrl: "http://127.0.0.1:8080",
      browserChannel: "chromium",
      browserHeadless: true,
      approvalLevel: 2,
      maxSteps: 25,
      completionMaxTokens: 1024,
      skillCount: 3,
      localBackendConfigured: false,
    },
    uiMode: "chat",
    activeTab: "feed",
    lastRunStatus: `failed [tool]: ENOENT ${CWD}/missing.txt for me@x.io`,
    messages: [
      { id: "m1", role: "user", text: `please read ${CWD}/secret.txt`, timestamp: 1 },
      {
        id: "m2",
        role: "assistant",
        text: `I used ${TOKEN}`,
        timestamp: 2,
        toolCards: [{ id: "c", tool: "os.fs.read", args: { path: `${CWD}/secret.txt` }, summary: "contents", status: "ok" }],
      },
    ],
    feed: [
      { id: "f1", kind: "runtime_info", stepIndex: null, line: `read ${CWD}/x`, color: "blue", timestamp: 3 },
    ],
    logs: [
      { level: "debug", message: `dbg ${HOME}/y`, timestamp: 4 },
      { level: "warn", message: "slow provider", context: { host: "10.0.0.5", key: TOKEN }, timestamp: 5 },
      { level: "error", message: `boom ${CWD}/z`, timestamp: 6 },
    ],
    reasoning: [{ id: "r", stepIndex: 0, text: "thinking about secrets", timestamp: 7 }],
    runHistory: [
      { message: "please read the secret file", outcome: "failed", reason: `ENOENT ${CWD}/missing.txt`, stepCount: 2, durationMs: 40, finishedAt: 8 },
    ],
    metrics: { turns: 1 } as unknown as DebugBundleSnapshot["metrics"],
  } as unknown as DebugBundleSnapshot;
}

function text(level: "errors" | "scrubbed" | "full"): { md: string; json: string } {
  const report = buildIssueReport({
    snapshot: snapshot(),
    facts: FACTS,
    level,
    redaction: { homeDir: HOME, workingDir: CWD },
  });
  return {
    md: [report.title, report.header, ...report.sections.map(renderSection)].join("\n"),
    json: JSON.stringify(report.snapshot),
  };
}

describe("buildIssueReport", () => {
  it("titles a failed turn after its status line", () => {
    const report = buildIssueReport({ snapshot: snapshot(), facts: FACTS, level: "errors", redaction: { homeDir: HOME, workingDir: CWD } });
    expect(report.title).toBe("Turn failed [tool]: ENOENT <cwd>/missing.txt for <email>");
    expect(report.header).toContain("| **Version** | 0.5.6 |");
    expect(report.header).toContain("openrouter · qwen/qwen3 (native_tools)");
    expect(report.header).toContain("Errors only");
  });

  it("errors: no chat, no feed, no paths, no debug lines, no user message", () => {
    const { md, json } = text("errors");
    for (const s of [md, json]) {
      expect(s).not.toContain(CWD);
      expect(s).not.toContain(HOME);
      expect(s).not.toContain("secret.txt");
      expect(s).not.toContain("secret file");
      expect(s).not.toContain("me@x.io");
      expect(s).not.toContain("thinking");
      expect(s).not.toContain("dbg ");
      expect(s).not.toContain(TOKEN);
      expect(s).not.toContain("10.0.0.5");
    }
    expect(md).toContain("Warnings and errors (2)");
    expect(md).toContain("boom <cwd>/z");
    expect(md).toContain("failed");
    expect(json).not.toContain("sessionId");
    expect(json).not.toContain("workingDir");
    expect(json).not.toContain("Runtime feed");
  });

  it("scrubbed: logs and feed with redaction, conversation shape only", () => {
    const { md, json } = text("scrubbed");
    expect(md).toContain("Logs (3)");
    expect(md).toContain("dbg ~/y");
    expect(md).toContain("Runtime feed (1)");
    expect(md).toContain("read <cwd>/x");
    expect(md).not.toContain("Conversation");
    for (const s of [md, json]) {
      expect(s).not.toContain(CWD);
      expect(s).not.toContain("secret.txt");
      expect(s).not.toContain("secret file");
      expect(s).not.toContain(TOKEN);
      expect(s).not.toContain("thinking");
    }
    // Shape of the conversation survives: roles and tool names.
    expect(json).toContain('"tools":["os.fs.read"]');
    expect(json).toContain('"workingDir":"<cwd>"');
    expect(json).not.toContain('"message":"please');
  });

  it("full: everything, secrets still masked", () => {
    const { md, json } = text("full");
    expect(md).toContain("Conversation (2 messages)");
    expect(md).toContain(`please read ${CWD}/secret.txt`);
    expect(json).toContain("thinking about secrets");
    expect(json).toContain('"message":"please read the secret file"');
    for (const s of [md, json]) expect(s).not.toContain(TOKEN);
    expect(json).toContain("<token>");
  });

  it("falls back to a generic title when the last run did not fail", () => {
    const snap = snapshot();
    snap.lastRunStatus = "completed";
    const report = buildIssueReport({ snapshot: snap, facts: FACTS, level: "errors", redaction: { homeDir: HOME } });
    expect(report.title).toBe("Issue report from atomic-agent v0.5.6");
  });
});
