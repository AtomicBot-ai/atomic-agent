import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime } from "./bootstrap.js";
import { resetConfigCache } from "../config/index.js";
import type { BrowserBackend } from "../tools/browser/browser-backend.js";
import type { TraceEvent } from "../tracing/trace/trace-event.js";

/**
 * Runtime-level contract for `createSession({ persist: false })`: the row
 * and the trace file are written by the first turn, not by the
 * allocation. The TUI mints its chat sessions that way — one the operator
 * never typed into left a row the session rail hides, and with no row on
 * screen there was nothing to press `x` on, so it could never be deleted.
 * Every other caller hands the id to something that will `load` it later
 * (a durable task, a webhook, a Telegram chat) and keeps the default.
 */
describe("createAgentRuntime deferred sessions", () => {
  let stateDir: string;
  let workingDir: string;
  // The browser is never touched by these turns; only `shutdown` runs.
  const backend = {
    ensureReady: async () => {},
    shutdown: async () => {},
  } as unknown as BrowserBackend;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-runtime-deferred-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cwd-deferred-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  const replyCompletion = async () => ({
    content: JSON.stringify({ tool: "reply", args: { text: "hi back" } }),
    timing: { promptTokens: 10, predictedTokens: 5 },
    slotId: 0,
    cacheReused: false,
  });

  const traced: TraceEvent[] = [];
  const bootRuntime = async () => {
    traced.length = 0;
    return createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      traceDefault: true,
      handlers: { traceSinks: [(event) => traced.push(event)] },
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
        llamaComplete: replyCompletion,
      },
    });
  };

  const tracePath = (sessionId: string) =>
    join(stateDir, "traces", `${sessionId}.ndjson`);

  it("persists and traces a session on the spot by default", async () => {
    const runtime = await bootRuntime();
    try {
      const session = runtime.createSession();
      expect(runtime.sessionStore.load(session.id)).not.toBeNull();
      expect(existsSync(tracePath(session.id))).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  });

  it("writes no row and no trace for a deferred session nobody speaks to", async () => {
    const runtime = await bootRuntime();
    try {
      const session = runtime.createSession({ persist: false });
      expect(runtime.sessionStore.load(session.id)).toBeNull();
      // `listRecent`, not the rail's page: the page hides a row with no
      // first prompt, so only a read of every row proves none was written.
      expect(runtime.sessionStore.listRecent(1000)).toEqual([]);
      expect(existsSync(tracePath(session.id))).toBe(false);
      expect(
        traced.some(
          (e) => e.type === "session_started" && e.sessionId === session.id,
        ),
      ).toBe(false);
    } finally {
      await runtime.shutdown();
    }
  });

  it("the first turn writes exactly one row and traces it from the start", async () => {
    const runtime = await bootRuntime();
    try {
      const session = runtime.createSession({ persist: false });
      const result = await runtime.runTurn(session, "hello", { maxSteps: 3 });
      expect(result.reason).toBe("reply");
      // One row, carrying the prompt that makes it visible on the rail.
      expect(runtime.sessionStore.listRecent(1000)).toHaveLength(1);
      const rows = runtime.sessionStore.listSummaryPage({ limit: 1000 });
      expect(rows.map((row) => [row.id, row.firstPrompt])).toEqual([
        [session.id, "hello"],
      ]);
      // The turn opens the recorder itself, so deferring the row costs
      // the trace nothing: the file exists and starts at the beginning.
      expect(existsSync(tracePath(session.id))).toBe(true);
      expect(
        traced.some(
          (e) => e.type === "session_started" && e.sessionId === session.id,
        ),
      ).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  });
});
