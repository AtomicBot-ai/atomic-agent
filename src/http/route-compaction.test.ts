import { afterEach, describe, expect, it, vi } from "vitest";
import { startTestHarness, type Harness, type HarnessOptions } from "./test-harness.js";
import { recordTurn, type SessionState } from "../session/session-state.js";
import { assistantToolCallTurn, toolResultTurn, userTurn } from "../session/conversation-turn.js";
import { SessionStore } from "../session/session-store.js";
import { join } from "node:path";
import type { CompletionResult } from "../llm/provider/completion-types.js";
import type { AgentLoopEvent } from "../agent/agent-contract.js";
import { LlamaServerError } from "../llm/llama-server-client.js";

const SUMMARY = "Goal: preserve the green button. Constraints: no deployment. Done: inspected files. Verification: reads succeeded. Unfinished: implement the requested fix and run checks. Paths: /file-0.";
function answer(content: string): CompletionResult {
  return { content, reasoningContent: "", stop: true, truncated: false, timing: { promptMs: 0, predictedMs: 0, promptTokens: 20, predictedTokens: 5 }, cacheHitTokens: 0, slotId: 0, modelId: "test", usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } };
}
const reply = () => answer('[{"tool":"reply","args":{"text":"done"}}]');
let h: Harness | undefined;
afterEach(async () => { await h?.cleanup(); h = undefined; });

async function setup(options: HarnessOptions = {}) {
  h = await startTestHarness({ llamaComplete: async (p) => p.sessionId.startsWith("compaction:") ? answer(SUMMARY) : reply(), ...options });
  h.runtime.config.agent.conversationMaxTokens = 4000;
  h.runtime.config.agent.compaction.summaryMaxTokens = 250;
  h.runtime.config.memory.reflection.enabled = false;
  h.runtime.config.agent.nameSessions = false;
  return h;
}
function fill(session: SessionState) {
  let state = recordTurn(session, userTurn("preserve the green button; do not deploy"));
  for (let i = 0; i < 20; i++) {
    state = recordTurn(state, assistantToolCallTurn({ tool: "os.fs.read", args: { path: `/file-${i}` } }));
    state = recordTurn(state, toolResultTurn({ tool: "os.fs.read", status: "ok", summary: `${i} ${"useful detail ".repeat(130)}` }));
  }
  return state;
}

describe("compaction HTTP and runtime persistence", () => {
  it("compacts via POST, reads via GET and survives reopening SQLite without rewriting transcript", async () => {
    const f = await setup();
    const state = fill(f.runtime.createSession());
    f.runtime.sessionStore.save(state);
    const response = await fetch(`${f.baseUrl}/api/sessions/${state.id}/compact`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "compacted", reason: "manual" });
    const checkpoint = f.runtime.getSessionCompaction(state.id);
    expect(checkpoint?.summary).toBe(SUMMARY);
    const view = await fetch(`${f.baseUrl}/api/sessions/${state.id}/compaction`);
    expect(await view.json()).toEqual({ sessionId: state.id, compaction: checkpoint });
    const reopened = new SessionStore({ dbFile: join(f.stateDir, "sessions.sqlite") });
    try {
      expect(reopened.load(state.id)?.turns).toEqual(state.turns);
      expect(reopened.load(state.id)?.compaction).toEqual(checkpoint);
      expect(reopened.load(state.id)?.turnCount).toBe(0);
    } finally { reopened.close(); }
  });
  it("keeps auth, missing-session and invalid-body responses", async () => {
    const f = await setup({ apiKey: "test-secret" });
    expect((await fetch(`${f.baseUrl}/api/sessions/missing/compact`, { method: "POST" })).status).toBe(401);
    const headers = { authorization: "Bearer test-secret" };
    expect((await fetch(`${f.baseUrl}/api/sessions/missing/compact`, { method: "POST", headers })).status).toBe(404);
    expect((await fetch(`${f.baseUrl}/api/sessions/missing/compaction`, { headers })).status).toBe(404);
    expect((await fetch(`${f.baseUrl}/api/sessions/missing/compact`, { method: "POST", headers, body: "{" })).status).toBe(400);
  });
  it("persists automatic checkpoints before inference and gives a deferred first session its turn owner", async () => {
    let observed: SessionState | null = null;
    const events: AgentLoopEvent[] = [];
    const f = await setup({ onAgentEvent: (event) => events.push(event), llamaComplete: async (p) => {
      if (p.sessionId.startsWith("compaction:")) return answer(SUMMARY);
      observed = h!.runtime.sessionStore.load(p.sessionId);
      return reply();
    } });
    const state = fill(f.runtime.createSession({ persist: false }));
    expect(f.runtime.sessionStore.load(state.id)).toBeNull();
    const result = await f.runtime.runTurn(state, "", { signal: new AbortController().signal, maxSteps: 3 });
    expect(observed).toMatchObject({ status: "running", compaction: { summary: SUMMARY } });
    expect(result.session.turnCount).toBe(1);
    expect(result.session.stepCount).toBe(1);
    expect(events.filter((e) => e.type === "compaction_completed")).toHaveLength(1);
    expect(result.session.turns.slice(0, state.turns.length)).toEqual(state.turns);
  });
  it.each(["inference", "tool"])("runs a manual request after the %s boundary, preserves late steering and never repeats tools", async (stage) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered = false, inference = 0, tools = 0, summaries = 0;
    let target = "";
    const prompts: string[] = [];
    const f = await setup({ llamaComplete: async (p) => {
      if (p.sessionId.startsWith("compaction:")) {
        summaries++;
        if (summaries === 1) h!.runtime.steer(p.sessionId.slice("compaction:".length), "LATEST: preserve keyboard shortcuts");
        return answer(SUMMARY);
      }
      if (p.sessionId !== target) return reply();
      inference++; prompts.push(p.prompt);
      if (inference === 1) {
        if (stage === "inference") { entered = true; await held; }
        return answer(JSON.stringify([{ tool: "os.fs.read", args: { path: join(h!.workingDir, "test-file") } }]));
      }
      return reply();
    } });
    f.runtime.config.agent.compaction.auto = false;
    f.runtime.toolRegistry.register({ name: "os.fs.read", description: "test step", readonly: true, run: async () => {
      tools++;
      if (stage === "tool") { entered = true; await held; }
      return { tool: "os.fs.read", status: "ok", summary: "step completed once", details: {}, truncated: false };
    } });
    const state = fill(f.runtime.createSession());
    f.runtime.sessionStore.save(state);
    target = state.id;
    const turn = f.runtime.runTurn(state, "continue", { maxSteps: 3, signal: new AbortController().signal });
    await vi.waitFor(() => expect(entered).toBe(true));
    const compact = f.runtime.compactSession(state.id);
    expect((await f.runtime.compactSession(state.id)).status).toBe("busy");
    expect(summaries).toBe(0);
    release();
    expect((await compact).status).toBe("compacted");
    const result = await turn;
    expect(tools, JSON.stringify(result.session.turns.slice(state.turns.length))).toBe(1);
    expect(prompts[1]).toContain("LATEST: preserve keyboard shortcuts");
    expect(result.session.compaction?.summary).toBe(SUMMARY);
    expect(result.session.turns.filter((t) => t.kind === "tool_result" && t.summary === "step completed once")).toHaveLength(1);
  });
  it("transfers a request from the terminal inference to FIFO without resetting turn counters", async () => {
    let release!: () => void, entered = false;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const f = await setup({ llamaComplete: async (p) => {
      if (p.sessionId.startsWith("compaction:")) return answer(SUMMARY);
      entered = true; await held; return reply();
    } });
    f.runtime.config.agent.compaction.auto = false;
    const state = fill(f.runtime.createSession()); f.runtime.sessionStore.save(state);
    const turn = f.runtime.runTurn(state, "continue", { maxSteps: 2, signal: new AbortController().signal });
    await vi.waitFor(() => expect(entered).toBe(true));
    const operation = f.runtime.compactSession(state.id); release();
    const result = await turn;
    expect((await operation).status).toBe("compacted");
    expect(f.runtime.sessionStore.load(state.id)?.turnCount).toBe(result.session.turnCount);
    expect(f.runtime.sessionStore.load(state.id)?.turns).toEqual(result.session.turns);
  });
  it("keeps compaction pending during an approval wait until the tool result is committed", async () => {
    let target = "", calls = 0, summaries = 0, waiting = false;
    const f = await setup({ approvalLevel: 1, onApprovalRequest: () => { waiting = true; }, llamaComplete: async (p) => {
      if (p.sessionId.startsWith("compaction:")) { summaries++; return answer(SUMMARY); }
      if (p.sessionId !== target) return reply();
      if (++calls === 1) return answer(JSON.stringify([{ tool: "os.fs.read", args: { path: join(h!.workingDir, "file") } }]));
      return reply();
    } });
    f.runtime.config.agent.compaction.auto = false;
    f.runtime.toolRegistry.register({ name: "os.fs.read", description: "approval fixture", readonly: true, run: async (_args, ctx) => {
      await f.runtime.approvals.request({ sessionId: target, tool: "os.fs.read", category: "shell", reason: "test barrier", approvalId: "compaction-barrier" }, { signal: ctx.signal });
      return { tool: "os.fs.read", status: "ok", summary: "approved result", details: {}, truncated: false };
    } });
    const state = fill(f.runtime.createSession()); target = state.id; f.runtime.sessionStore.save(state);
    const turn = f.runtime.runTurn(state, "continue", { maxSteps: 3, signal: new AbortController().signal });
    await vi.waitFor(() => expect(waiting).toBe(true));
    const operation = f.runtime.compactSession(state.id);
    expect(summaries).toBe(0);
    f.runtime.approvals.resolve({ approvalId: "compaction-barrier", approved: true });
    expect((await operation).status).toBe("compacted");
    const result = await turn;
    expect(result.session.turns.some((t) => t.kind === "tool_result" && t.summary === "approved result")).toBe(true);
    expect(result.reason).toBe("reply");
  });
  it("disconnect cancels only the HTTP compaction request", async () => {
    let entered = false, subcallSignal: AbortSignal | undefined;
    const f = await setup({ llamaComplete: async (p) => {
      if (p.sessionId.startsWith("compaction:")) {
        entered = true; subcallSignal = p.signal;
        return new Promise(() => {});
      }
      return reply();
    } });
    const state = fill(f.runtime.createSession()); f.runtime.sessionStore.save(state);
    const abort = new AbortController();
    const request = fetch(`${f.baseUrl}/api/sessions/${state.id}/compact`, { method: "POST", signal: abort.signal }).catch(() => null);
    await vi.waitFor(() => expect(entered).toBe(true));
    abort.abort(); await request;
    await vi.waitFor(() => expect(subcallSignal?.aborted).toBe(true));
    expect(f.runtime.getSessionCompaction(state.id)).toBeNull();
    f.runtime.config.agent.compaction.auto = false;
    const result = await f.runtime.runTurn(state, "continue", { signal: new AbortController().signal, maxSteps: 2 });
    expect(result.reason).toBe("reply");
  });
  it.each([false, true])("recovers a context refusal once, without replaying tools (repeat refusal: %s)", async (repeat) => {
    let target = "", calls = 0, tools = 0;
    const events: AgentLoopEvent[] = [];
    const f = await setup({ onAgentEvent: (event) => events.push(event), llamaComplete: async (p) => {
      if (p.sessionId.startsWith("compaction:")) return answer(SUMMARY);
      if (p.sessionId !== target) return reply();
      calls++;
      if (calls === 1) return answer(JSON.stringify([{ tool: "os.fs.read", args: { path: join(h!.workingDir, "file") } }]));
      if (calls === 2 || repeat) throw new LlamaServerError("maximum context length is 64000 tokens; requested tokens exceed the limit", 400, "http://model");
      return reply();
    } });
    f.runtime.config.agent.compaction.auto = false;
    f.runtime.toolRegistry.register({ name: "os.fs.read", description: "test read", readonly: true, run: async () => {
      tools++;
      return { tool: "os.fs.read", status: "ok", summary: "one completed read", details: {}, truncated: false };
    } });
    const state = fill(f.runtime.createSession()); target = state.id; f.runtime.sessionStore.save(state);
    const result = await f.runtime.runTurn(state, "continue", { maxSteps: 5, signal: new AbortController().signal });
    expect(result.reason).toBe(repeat ? "failed" : "reply");
    expect(result.session.compaction?.reason).toBe("overflow");
    expect(calls).toBe(3);
    expect(tools).toBe(1);
    expect(events.filter((e) => e.type === "compaction_completed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "loop_failed")).toHaveLength(repeat ? 1 : 0);
  });
});
