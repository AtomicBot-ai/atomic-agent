import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GITHUB_NOT_CONNECTED } from "../../github/index.js";
import { createInitialTuiState } from "../tui-state.js";
import type { TuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import {
  ISSUE_REPORT_REPO,
  IssueReportOrchestrator,
  type IssueReportDeps,
} from "./issue-report-orchestrator.js";

const TOKEN = `ghp_${"A".repeat(36)}`;

function makeBus() {
  const actions: Array<{ type: string } & Record<string, unknown>> = [];
  return {
    emit(action: unknown) {
      actions.push(action as { type: string } & Record<string, unknown>);
    },
    actions,
    last(type: string) {
      return actions.filter((a) => a.type === type).at(-1);
    },
  };
}

function fakeApi() {
  const calls: Array<{ op: string; body: string; title?: string }> = [];
  return {
    calls,
    createIssue: vi.fn(async (input: { title: string; body?: string; labels?: readonly string[] }) => {
      calls.push({ op: "issue", body: input.body ?? "", title: input.title });
      return {
        number: 42,
        title: input.title,
        state: "open",
        htmlUrl: "https://github.com/AtomicBot-ai/atomic-agent/issues/42",
        author: "me",
        labels: [...(input.labels ?? [])],
        createdAt: "",
        isPullRequest: false,
      };
    }),
    addIssueComment: vi.fn(async (input: { number: number; body: string }) => {
      calls.push({ op: "comment", body: input.body });
      return { id: calls.length, htmlUrl: "c" };
    }),
  };
}

describe("IssueReportOrchestrator", () => {
  let dir: string;
  let traceDir: string;
  let outDir: string;
  let state: TuiState;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "issue-report-"));
    traceDir = join(dir, "traces");
    outDir = join(dir, "out");
    state = createInitialTuiState(fakeSession());
    state = {
      ...state,
      session: { ...state.session, sessionId: "sess-1", workingDir: `${dir}/proj` },
      lastRunStatus: `failed [tool]: boom in ${dir}/proj/a.ts`,
      logs: [{ level: "error", message: `died ${dir}/proj/a.ts`, timestamp: 1 }],
      runHistory: [
        { message: "do the thing", outcome: "failed", reason: "boom", stepCount: 1, durationMs: 5, finishedAt: 1 },
      ],
    };
    mkdirSync(traceDir, { recursive: true });
    writeFileSync(
      join(traceDir, "sess-1.ndjson"),
      `${JSON.stringify({ seq: 1, type: "prompt_captured", sessionId: "sess-1", ts: 1, tail: "private prompt" })}\n${JSON.stringify({ seq: 2, type: "error", sessionId: "sess-1", ts: 2, message: "boom" })}\n`,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function make(deps: Partial<IssueReportDeps> & { api?: ReturnType<typeof fakeApi> } = {}) {
    const bus = makeBus();
    const api = deps.api ?? fakeApi();
    const orchestrator = new IssueReportOrchestrator(
      {
        config: { tracing: { trace: { dir: traceDir, enabled: true, maxBytesPerSession: 1 } } },
        sessionStore: { listRecent: () => [{ id: "sess-1" }, { id: "sess-0" }] as never },
      },
      bus,
      {
        resolveToken: () => TOKEN,
        apiFactory: () => api,
        // A home that is NOT the temp root, so a temp path that leaks
        // cannot hide behind the `~` substitution.
        homeDir: join(dir, "home"),
        outDir,
        now: () => new Date("2026-09-09T00:00:00Z"),
        ...deps,
      },
    );
    return { orchestrator, bus, api };
  }

  it("pick writes the zip and previews before anything is sent", async () => {
    const { orchestrator, bus, api } = make();
    orchestrator.open();
    expect(bus.last("issue_report_opened")).toBeDefined();
    await orchestrator.pick("errors", state);
    const previewed = bus.last("issue_report_previewed") as { preview: Record<string, unknown> };
    expect(previewed).toBeDefined();
    const preview = previewed.preview as { zipPath: string; level: string; comments: number; title: string };
    expect(preview.level).toBe("errors");
    expect(preview.title).toContain("Turn failed");
    expect(preview.zipPath.startsWith(outDir)).toBe(true);
    expect(readdirSync(outDir)).toHaveLength(1);
    expect(api.calls).toEqual([]);

    const zip = await JSZip.loadAsync(readFileSync(preview.zipPath));
    const names = Object.keys(zip.files).sort();
    // Traces are named by ordinal: a session id is a join key.
    expect(names).toEqual(["report.md", "snapshot.json", "traces/", "traces/1.ndjson"]);
    const trace = await zip.file("traces/1.ndjson")!.async("string");
    expect(trace).not.toContain("sess-1");
    const snapshot = await zip.file("snapshot.json")!.async("string");
    expect(snapshot).not.toContain(dir);
    expect(snapshot).not.toContain("sess-");
    // The second requested trace does not exist; only its errno is recorded.
    expect(snapshot).toContain('"reason": "ENOENT"');
    // errors level: the prompt row is gone, the error row stays.
    expect(trace).not.toContain("private prompt");
    expect(trace).toContain('"type":"error"');
    const md = await zip.file("report.md")!.async("string");
    expect(md).not.toContain(dir);
    expect(md).toContain("died <cwd>/a.ts");
  });

  it("send files the issue with the prepared body and reports the url", async () => {
    const { orchestrator, bus, api } = make();
    orchestrator.open();
    await orchestrator.pick("scrubbed", state);
    await orchestrator.send();
    expect(bus.last("issue_report_failed")).toBeUndefined();
    const sent = bus.last("issue_report_sent") as { url: string };
    expect(sent.url).toBe("https://github.com/AtomicBot-ai/atomic-agent/issues/42");
    expect(api.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ ...ISSUE_REPORT_REPO, labels: ["bug", "from-agent"] }),
    );
    const issue = api.calls.find((c) => c.op === "issue")!;
    expect(issue.body).toContain("Logs, scrubbed");
    expect(issue.body).not.toContain(dir);
    expect(issue.body).toContain("<cwd>/a.ts");
    const msg = bus.last("system_message") as { text: string };
    expect(msg.text).toContain("Issue filed: https://github.com/AtomicBot-ai/atomic-agent/issues/42");
    expect(msg.text).toContain("report zip:");
  });

  it("refuses to send without a token and points at the hub", async () => {
    const { orchestrator, bus, api } = make({ resolveToken: () => null });
    orchestrator.open();
    await orchestrator.pick("errors", state);
    await orchestrator.send();
    expect((bus.last("issue_report_failed") as { error: string }).error).toBe(GITHUB_NOT_CONNECTED);
    expect(api.calls).toEqual([]);
  });

  it("refuses to send before a level was picked", async () => {
    const { orchestrator, bus, api } = make();
    orchestrator.open();
    await orchestrator.send();
    expect((bus.last("issue_report_failed") as { error: string }).error).toMatch(/pick a level/);
    expect(api.calls).toEqual([]);
  });

  it("closing forgets the prepared report", async () => {
    const { orchestrator, bus, api } = make();
    orchestrator.open();
    await orchestrator.pick("errors", state);
    orchestrator.close();
    expect(bus.last("issue_report_closed")).toBeDefined();
    await orchestrator.send();
    expect(api.calls).toEqual([]);
  });

  it("surfaces a GitHub refusal as the popup's error, scrubbed", async () => {
    const api = fakeApi();
    api.createIssue.mockImplementationOnce(async () => {
      throw new Error(`HTTP 401 for ${TOKEN}`);
    });
    const { orchestrator, bus } = make({ api });
    orchestrator.open();
    await orchestrator.pick("errors", state);
    await orchestrator.send();
    const failed = bus.last("issue_report_failed") as { error: string };
    expect(failed.error).toContain("HTTP 401");
    expect(failed.error).not.toContain(TOKEN);
  });

  it("a close during the build drops the late result", async () => {
    const { orchestrator, bus, api } = make();
    orchestrator.open();
    const building = orchestrator.pick("errors", state);
    orchestrator.close();
    await building;
    expect(bus.last("issue_report_previewed")).toBeUndefined();
    expect(bus.last("issue_report_failed")).toBeUndefined();
    await orchestrator.send();
    expect(api.calls).toEqual([]);
  });

  it("full level keeps the prompt in the zipped trace", async () => {
    const { orchestrator, bus } = make();
    orchestrator.open();
    await orchestrator.pick("full", state);
    const preview = (bus.last("issue_report_previewed") as { preview: { zipPath: string } }).preview;
    const zip = await JSZip.loadAsync(readFileSync(preview.zipPath));
    const trace = await zip.file("traces/1.ndjson")!.async("string");
    expect(trace).toContain("private prompt");
    expect(trace).toContain("sess-1");
  });
});

