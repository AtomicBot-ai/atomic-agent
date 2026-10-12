import { describe, expect, it, vi } from "vitest";
import { executeStep } from "./step-executor.js";
import type { StepContext, StepDependencies } from "./step/step-contract.js";
import { createEmptySessionState } from "../session/session-state.js";
import { userTurn, assistantReplyTurn } from "../session/conversation-turn.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { SlotManager } from "../llm/slot-manager.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import { fakeAnswer, fakeProvider } from "../llm/provider/fake-provider.fixture.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import { buildPrompt } from "../prompt/build-prompt.js";
import { withParseWarning } from "../tools/os/fs/fs-parse-check.js";
import { withReplaceNotes } from "../tools/os/fs/fs-replace-guard.js";
import { buildOpenAiChatBody } from "../llm/provider/openai/openai-build-body.js";
import { captureModelModePolicy } from "../llm/model-mode.js";
import { createFallbackCompleter, createFallbackStreamer } from "../runtime/llm-fallback-seam.js";
import { ProviderFallbackChain } from "../llm/fallback/index.js";
import { DEFAULT_FALLBACK_TIMING } from "../llm/fallback/fallback-config.js";
import { OpenAiHttpError } from "../llm/provider/openai/openai-http.js";
import type { CompletionRequest } from "../llm/provider/completion-types.js";
import { AgentLoop } from "./agent-loop.js";
import { SessionStore } from "../session/session-store.js";
import { planCompaction } from "../prompt/plan-compaction.js";
import { getConfig } from "../config/index.js";

const cloud = { mode: "cloud" as const, source: "provider" as const, providerId: "cloud", modelId: "big" };
function context(): StepContext {
  const session = createEmptySessionState({ id: "seam", workingDir: "/fixture" });
  session.turns = [userTurn("inspect")];
  return { session, stepIndex: 0, signal: new AbortController().signal,
    toolDescriptors: DEFAULT_TOOL_DESCRIPTORS, skillCatalog: [],
    capabilities: { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/fixture", hasClipboard: false, hasWmctrl: false, hasNotifications: false } };
}
function dependencies(registry: ToolRegistry, llmComplete: StepDependencies["llmComplete"]): StepDependencies {
  return { registry, llmComplete, slotManager: new SlotManager(1), grammar: "", profile: PLAIN_INSTRUCT_PROFILE,
    toolTransport: "native_tools", toolCallAdapter: null, supportsSlotAffinity: false, modelMode: cloud, contextWindow: 200000, profileWindowApplies: false };
}

describe("cloud output → transcript → request", () => {
  it("uses a sticky cloud fallback before maintenance so local pair caps cannot compact it early", async () => {
    const ctx = context();
    const body = "Full instructions\n".repeat(2000) + "LAST RULE";
    ctx.session.loadedSkills = [{ name: "guide", version: "1", body, loadedAt: 1 }];
    for (let i = 0; i < 20; i++) ctx.session.turns.push(assistantReplyTurn("done"), userTurn("continue"));
    const modelModePolicy = captureModelModePolicy({ activeTextProvider: "local", activeEmbeddingProvider: "local", toolTransport: "auto",
      providers: [{ id: "local", kind: "llama-server" }, { id: "cloud", kind: "openrouter", modelMode: "cloud" }] });
    const registry = new ToolRegistry();
    registry.register({ name: "reply", description: "reply", readonly: true, async run() { return compressToolResult({ tool: "reply", status: "ok", output: "done" }); } });
    const beforeStep = vi.fn((input: Parameters<typeof buildPrompt>[0]) => {
      const prompt = buildPrompt(input);
      expect(input.modelMode?.mode).toBe("cloud");
      expect(prompt.contextWindow).toBe(200000);
      expect(prompt.text).toContain(body);
      expect(planCompaction(input.session, prompt, getConfig().agent.compaction)).toBeNull();
      return undefined;
    });
    const loop = new AgentLoop({ registry, slotManager: new SlotManager(1), grammar: "", profile: { ...PLAIN_INSTRUCT_PROFILE, contextWindow: 4096 },
      contextWindow: () => 4096, toolTransport: "grammar", supportsSlotAffinity: true,
      contextProviderId: () => "cloud", resolveLlmSlice: () => ({ contextWindow: 200000, toolTransport: "native_tools", toolCallAdapter: null,
        supportsSlotAffinity: false, supportsParallelTools: true, strictTools: false, isLlamaServer: false }),
      toolDescriptors: DEFAULT_TOOL_DESCRIPTORS, capabilities: ctx.capabilities, skillCatalog: [],
      compaction: { open() {}, close() {}, beforeStep },
      llmComplete: async params => {
        expect(params.prompt).toContain(body);
        return { ...fakeAnswer("cloud"), toolCalls: [{ function: { name: "reply", arguments: '{"text":"done"}' } }] };
      } });
    const result = await loop.runTurn(ctx.session, { maxSteps: 2, signal: ctx.signal, modelModePolicy });
    expect(result.reason).toBe("reply");
    expect(beforeStep).toHaveBeenCalledOnce();
  });

  it("saves model-visible context before inference and completed pairs on cancellation", async () => {
    const ctx = context();
    const body = "Instructions\n".repeat(2000) + "LAST RULE";
    ctx.session.loadedSkills = [{ name: "guide", version: "1", body, loadedAt: 1 }];
    const abort = new AbortController();
    const registry = new ToolRegistry();
    const raw = "Evidence\n".repeat(3000) + "LAST EVIDENCE";
    registry.register({ name: "os.fs.read", description: "read", readonly: true, async run() {
      abort.abort();
      return compressToolResult({ tool: "os.fs.read", status: "ok", output: raw });
    } });
    const store = new SessionStore({ dbFile: ":memory:" });
    const persistContext = vi.fn((state: StepContext["session"]) => store.save(state));
    try {
      const loop = new AgentLoop({ registry, slotManager: new SlotManager(1), grammar: "", profile: PLAIN_INSTRUCT_PROFILE,
        contextWindow: () => 200000, toolTransport: "native_tools", supportsSlotAffinity: false,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS, capabilities: ctx.capabilities, skillCatalog: [], persistContext,
        llmComplete: async () => {
          expect(store.load(ctx.session.id)!.cloudContext!.entries.some(entry => entry.turn.kind === "user" && entry.turn.text.includes(body))).toBe(true);
          return { ...fakeAnswer("cloud"), toolCalls: [
            { function: { name: "os__fs__read", arguments: '{"path":"a"}' } },
            { function: { name: "os__fs__read", arguments: '{"path":"b"}' } },
          ] };
        } });
      const modelModePolicy = captureModelModePolicy({ activeTextProvider: "cloud", activeEmbeddingProvider: "cloud", toolTransport: "auto",
        providers: [{ id: "cloud", kind: "openrouter", modelMode: "cloud" }] });
      const result = await loop.runTurn(ctx.session, { maxSteps: 2, signal: abort.signal, modelModePolicy });
      expect(result.reason).toBe("cancelled");
      const saved = store.load(ctx.session.id)!;
      expect(saved.turns.filter(turn => turn.kind === "assistant_tool_call")).toHaveLength(2);
      expect(saved.turns.filter(turn => turn.kind === "tool_result")).toHaveLength(2);
      expect(saved.turns.find(turn => turn.kind === "tool_result" && turn.status === "ok")).toMatchObject({ summary: raw });
      expect(buildPrompt({ ...ctx, session: saved, modelMode: cloud, contextWindow: 200000 }).text).toContain(body);
    } finally { store.close(); }
  });

  it("retains the entire raw batch across compression, reply aging and restoration", async () => {
    const raw = "FIRST\n" + "middle evidence\n".repeat(4000) + "LAST\n";
    const registry = new ToolRegistry();
    registry.register({ name: "os.fs.read", description: "read", readonly: true, async run() {
      return compressToolResult({ tool: "os.fs.read", status: "ok", output: raw });
    } });
    const ctx = context();
    const deps = dependencies(registry, async () => ({ ...fakeAnswer("cloud"), toolCalls: [
      { function: { name: "os__fs__read", arguments: '{"path":"a"}' } },
      { function: { name: "os__fs__read", arguments: '{"path":"b"}' } },
    ] }));
    const outcome = await executeStep(ctx, deps);
    const results = outcome.nextSession.turns.filter(t => t.kind === "tool_result");
    expect(results).toHaveLength(2);
    for (const result of results) expect(result.summary).toBe(raw);
    outcome.nextSession.turns.push(assistantReplyTurn("done"), userTurn("continue"));
    const restored = JSON.parse(JSON.stringify(outcome.nextSession));
    const prompt = buildPrompt({ ...ctx, session: restored, modelMode: cloud, toolTransport: "native_tools", suppressReasoningPrefill: true, contextWindow: 200000 });
    const messages = buildOpenAiChatBody({ prompt: prompt.text, messages: prompt.messages, tools: [{ type: "function", function: { name: "read" } }] }, "model", false).messages as Array<Record<string, unknown>>;
    expect(messages.filter(message => message.role === "tool").map(message => message.content)).toEqual([raw, raw]);
    const local = await registry.invoke("os.fs.read", {}, { workingDir: "/fixture", sessionId: "local", stepIndex: 0, signal: ctx.signal });
    expect(local.summary.length).toBeLessThanOrEqual(400);
    expect(JSON.stringify(local)).not.toContain("fullOutput");
  });

  it("preserves guard annotations and explicit source truncation", async () => {
    const raw = "full\n".repeat(3000);
    const registry = new ToolRegistry();
    registry.register({ name: "test", description: "test", readonly: true, async run() {
      return withReplaceNotes(withParseWarning(compressToolResult({ tool: "test", status: "ok", output: raw, details: { truncated: true } }), "parse warning"), []);
    } });
    const result = await registry.invoke("test", {}, { workingDir: "/fixture", sessionId: "s", stepIndex: 0, signal: context().signal, modelMode: "cloud" });
    expect(result.summary).toBe(`parse warning\n${raw}`);
    expect(result.truncated).toBe(true);
  });

  it.each([false, true])("rebuilds a cloud primary for a local fallback and its window (stream=%s)", async streaming => {
    const ctx = context();
    ctx.session.loadedSkills = [{ name: "long", version: "1", body: "rule\n".repeat(4000), loadedAt: 1 }];
    const modelModePolicy = captureModelModePolicy({ activeTextProvider: "cloud", activeEmbeddingProvider: "cloud", toolTransport: "auto",
      providers: [{ id: "cloud", kind: "openrouter", modelMode: "cloud" }, { id: "local", kind: "llama-server", modelMode: "local" }] });
    const observed: CompletionRequest[] = [];
    const providers = [fakeProvider("cloud", "native_tools", async request => {
      observed.push(request);
      throw new OpenAiHttpError("rate limited", 429, "http://cloud", false, null, "cloud");
    }), fakeProvider("local", "grammar", async request => {
      observed.push(request);
      return fakeAnswer("local", '[{"tool":"reply","args":{"text":"done"}}]');
    })];
    const seam = { fallbackChain: new ProviderFallbackChain({ resolve: () => ({ chain: ["cloud", "local"], timing: DEFAULT_FALLBACK_TIMING }) }),
      resolveSlice: (id: string) => ({ provider: providers.find(p => p.id === id)!, transport: id === "cloud" ? "native_tools" as const : "grammar" as const,
        contextWindow: id === "cloud" ? 200000 : 16000 }), recordUnaryUsage: () => {}, recordStreamUsage: () => {} };
    const deps = { ...dependencies(new ToolRegistry(), createFallbackCompleter(seam)), modelModePolicy,
      ...(streaming ? { llmCompleteStream: createFallbackStreamer(seam) } : {}) };
    deps.registry.register({ name: "reply", description: "reply", readonly: true, async run() { return compressToolResult({ tool: "reply", status: "ok", output: "done" }); } });
    await executeStep(ctx, deps);
    expect(observed[0]?.prompt).toContain(ctx.session.loadedSkills[0]!.body);
    expect(observed[0]?.contextBudget?.window).toBe(200000);
    expect(observed[1]?.prompt).not.toContain(ctx.session.loadedSkills[0]!.body);
    expect(observed[1]?.modelMode?.mode).toBe("local");
    expect(observed[1]?.contextBudget).toBeUndefined();
    expect(observed[1]?.messages).toBeUndefined();
  });

  it.each([false, true])("rejects a smaller cloud fallback before sending or shortening history (stream=%s)", async streaming => {
    const ctx = context();
    const body = "Full rule\n".repeat(4000) + "LAST RULE";
    ctx.session.loadedSkills = [{ name: "guide", version: "1", body, loadedAt: 1 }];
    const modelModePolicy = captureModelModePolicy({ activeTextProvider: "cloud", activeEmbeddingProvider: "cloud", toolTransport: "auto",
      providers: [{ id: "cloud", kind: "openrouter", modelMode: "cloud" }, { id: "smaller", kind: "openrouter", modelMode: "cloud" }] });
    const primary = vi.fn(async () => { throw new OpenAiHttpError("rate limited", 429, "http://cloud", false, null, "cloud"); });
    const smaller = vi.fn(async () => fakeAnswer("smaller"));
    const seam = {
      fallbackChain: new ProviderFallbackChain({ resolve: () => ({ chain: ["cloud", "smaller"], timing: DEFAULT_FALLBACK_TIMING }) }),
      resolveSlice: (id: string) => ({ provider: fakeProvider(id, "native_tools", id === "cloud" ? primary : smaller),
        transport: "native_tools" as const, contextWindow: id === "cloud" ? 200000 : 8000 }),
      recordUnaryUsage: () => {}, recordStreamUsage: () => {},
    };
    const deps = { ...dependencies(new ToolRegistry(), createFallbackCompleter(seam)), modelModePolicy,
      ...(streaming ? { llmCompleteStream: createFallbackStreamer(seam) } : {}) };
    await expect(executeStep(ctx, deps)).rejects.toThrow(/context window: 8000 tokens/);
    expect(primary).toHaveBeenCalledOnce();
    expect(smaller).not.toHaveBeenCalled();
    expect(JSON.stringify(ctx.session.cloudContext)).toContain("LAST RULE");
    expect(buildPrompt({ ...ctx, session: ctx.session, modelMode: cloud, contextWindow: 200000 }).text).toContain(body);
  });
});
