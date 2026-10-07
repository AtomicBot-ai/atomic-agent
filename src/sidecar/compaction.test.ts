import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as bootstrap from "../runtime/bootstrap.js";
import { bootstrapSidecar } from "./main.js";
import { getConfig, resetConfigCache } from "../config/index.js";
import { FakeBrowserBackend } from "../http/test-harness.js";
import { recordTurn, userTurn, assistantReplyTurn } from "../session/index.js";
import type { CompletionResult } from "../llm/provider/completion-types.js";
import type { AgentLoopEvent } from "../agent/agent-contract.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetConfigCache(); });

it("correlates compaction controls and reloads the checkpoint inside send_message's lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sidecar-compaction-"));
  vi.stubEnv("ATOMIC_AGENT_STATE_DIR", dir);
  vi.stubEnv("ATOMIC_AGENT_GRAMMARS_DIR", join(process.cwd(), "grammars"));
  resetConfigCache();
  const config = getConfig();
  config.agent.compaction.auto = false;
  config.agent.compaction.summaryMaxTokens = 250;
  config.agent.conversationMaxTokens = 4000;
  config.agent.nameSessions = false;
  config.memory.reflection.enabled = false;
  const summary = "Goal: keep the blue button. Done: read the files. Pending: run tests; nothing has been deployed.";
  const completion = (content: string): CompletionResult => ({ content, reasoningContent: "", stop: true, truncated: false, timing: { promptTokens: 20, predictedTokens: 5, promptMs: 1, predictedMs: 1 }, slotId: 0, cacheHitTokens: 0, modelId: "test" });
  const seen: string[] = [];
  let forward: ((event: AgentLoopEvent, sessionId?: string) => void) | undefined;
  const runtime = await bootstrap.createAgentRuntime({ workingDir: dir, approvalLevel: 5,
    handlers: { onAgentEvent: (event, sessionId) => forward?.(event, sessionId) }, overrides: {
    browserBackend: new FakeBrowserBackend(), skipLlamaHealthCheck: true,
    llamaComplete: async (p) => {
      if (p.sessionId.startsWith("compaction:")) return completion(summary);
      seen.push(p.prompt);
      return completion('[{"tool":"reply","args":{"text":"done"}}]');
    },
  } });
  let state = runtime.createSession();
  for (let i = 0; i < 15; i++) {
    state = recordTurn(state, userTurn(`request ${i}: keep the blue button`));
    state = recordTurn(state, assistantReplyTurn(`result ${i}: ${"important details ".repeat(150)}`));
  }
  runtime.sessionStore.save(state);
  vi.spyOn(bootstrap, "createAgentRuntime").mockImplementation(async (options) => {
    forward = options.handlers?.onAgentEvent;
    return runtime;
  });
  vi.spyOn(runtime, "createSession").mockReturnValue(state);
  vi.stubGlobal("fetch", async () => new Response('{"status":"ok"}'));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const kept = [process.stdin.listeners("data"), process.stdin.listeners("end"), process.stdout.listeners("error"), process.stdout.listeners("close")];
  const sidecar = await bootstrapSidecar();
  const emitted = vi.spyOn(sidecar.protocol, "emitEvent");
  const responses = new Map<string, { ok: boolean; payload: unknown }>();
  vi.spyOn(sidecar.protocol, "respond").mockImplementation((id, payload, ok = true) => { responses.set(id, { ok, payload }); return { kind: "response", id: `response-${id}`, correlationId: id, ok, payload }; });
  const request = async (id: string, type: string, payload: unknown) => {
    process.stdin.emit("data", JSON.stringify({ kind: "request", id, type, payload }) + "\n");
    await vi.waitFor(() => expect(responses.has(id)).toBe(true));
    return responses.get(id)!;
  };
  try {
    expect((await request("start", "start_session", { workingDir: dir })).ok).toBe(true);
    expect(await request("before", "get_compaction", { sessionId: state.id })).toEqual({ ok: true, payload: null });
    expect(await request("compact", "compact_session", { sessionId: state.id })).toMatchObject({ ok: true, payload: { status: "compacted" } });
    expect(emitted).toHaveBeenCalledWith("compaction_progress", expect.objectContaining({ sessionId: state.id, completedChunks: 0 }));
    expect(await request("show", "get_compaction", { sessionId: state.id })).toMatchObject({ ok: true, payload: { summary } });
    expect((await request("next", "send_message", { sessionId: state.id, text: "continue", maxSteps: 2 })).ok).toBe(true);
    expect(seen.some((prompt) => prompt.includes(summary))).toBe(true);
    expect(runtime.getSessionCompaction(state.id)?.summary).toBe(summary);
    expect(runtime.sessionStore.load(state.id)?.turns.slice(0, state.turns.length)).toEqual(state.turns);
    expect((await request("bad", "compact_session", {})).ok).toBe(false);
  } finally {
    const streams = [process.stdin, process.stdin, process.stdout, process.stdout];
    ["data", "end", "error", "close"].forEach((event, i) => {
      for (const listener of streams[i]!.listeners(event)) if (!kept[i]!.includes(listener)) streams[i]!.removeListener(event, listener as () => void);
    });
    await sidecar.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
