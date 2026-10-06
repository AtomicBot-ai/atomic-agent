import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfigCache } from "../../config/index.js";
import type { AtomicAgentConfig } from "../../config/config-schema.js";
import type { LlmStreamParams } from "../../agent/step-executor.js";
import type { CompletionResult } from "../../llm/provider/completion-types.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { MetricsCollector } from "../../tracing/metrics-collector.js";
import { AgentMetrics } from "../../tracing/agent-metrics.js";
import { createTraceRecorder, type TraceRecorder } from "../../tracing/trace/trace-recorder.js";
import type { TraceEvent } from "../../tracing/trace/trace-event.js";
import { VoteStore } from "../../memory/voting/vote-store.js";
import type { ConsolidatorJob } from "../../memory/consolidator/consolidator-job.js";
import type { MemoryHealthAnnouncer } from "../announce-memory-health.js";
import type { SubcallComplete } from "../abortable-subcall.js";
import { createRuntimeMemoryStores, type RuntimeMemoryStores } from "./runtime-memory-stores.js";
import { createRuntimeMemoryConsolidator, createRuntimeMemoryServices } from "./runtime-memory-services.js";

let dir: string;
let config: AtomicAgentConfig;
let stores: RuntimeMemoryStores;
let previous: Map<string, string | undefined>;
let services: ReturnType<typeof createRuntimeMemoryServices> | undefined;
let job: ConsolidatorJob | null;
const logger = new StructuredLogger({ level: "error", sinks: [] });
const metrics = new AgentMetrics(new MetricsCollector({ sinks: [] }));
const unexpected = (): never => { throw new Error("No model/network invocation without an explicit test completion"); };
const completion = (content = "NONE"): CompletionResult => ({ content, timing: { promptMs: 1, predictedMs: 1, promptTokens: 1, predictedTokens: 1 }, slotId: 0, reasoningContent: "", stop: true, truncated: false, cacheHitTokens: 0, modelId: null });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atomic-memory-services-"));
  previous = new Map();
  for (const key of Object.keys(process.env)) if (key.startsWith("ATOMIC_AGENT_")) { previous.set(key, process.env[key]); delete process.env[key]; }
  if (!previous.has("ATOMIC_AGENT_STATE_DIR")) previous.set("ATOMIC_AGENT_STATE_DIR", undefined);
  process.env.ATOMIC_AGENT_STATE_DIR = dir;
  resetConfigCache(); config = loadConfig();
  config.paths.memoryDbFile = join(dir, "memory.sqlite");
  config.memory.embeddings.enabled = false; config.localModels.embeddings.enabled = false;
  config.memory.links.enabled = false; config.memory.voting.enabled = false;
  config.memory.evolution.enabled = false; config.memory.retrieve.rewriter.enabled = false;
  config.memory.reflection.enabled = true; config.memory.profile.enabled = true;
  config.memory.consolidation.enabled = false;
  stores = await createRuntimeMemoryStores({ config, metrics, onProfileEvicted: unexpected });
  services = undefined; job = null;
});
afterEach(() => {
  services?.reflectionRunner?.abortPending(); job?.stop();
  vi.restoreAllMocks(); vi.useRealTimers();
  stores.profileStore.close(); stores.lessonStore.close(); stores.procedureStore.close(); stores.notesStore.close();
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  resetConfigCache(); rmSync(dir, { recursive: true, force: true });
});
function dependencies(llmComplete: SubcallComplete = async () => unexpected()) {
  return { ...stores, config, slotManager: { sideCallSlotId: () => -1 }, llmComplete, logger, metrics, touchRecorder: (_sessionId: string): TraceRecorder | undefined => undefined, memoryHealth: { observe: () => {} } };
}

describe("runtime memory services composition", () => {
  it("skips disabled layers without resolving a slot or invoking completion", () => {
    config.memory.profile.enabled = false; config.memory.notes.enabled = false;
    const slot = vi.fn(unexpected); const llm = vi.fn(async () => unexpected());
    services = createRuntimeMemoryServices({ ...dependencies(llm), slotManager: { sideCallSlotId: slot } });
    expect(services.reflectionRunner).toBeUndefined(); expect(services.memoryContextProvider).toBeUndefined();
    expect(slot).not.toHaveBeenCalled(); expect(llm).not.toHaveBeenCalled();
    expect(createRuntimeMemoryConsolidator({ ...dependencies(llm), traceBus: null })).toBeNull();
  });

  it("resolves slots/completion/recorders late and records each owning session before its health outcome", async () => {
    config.memory.notes.enabled = false;
    let slot = 1; let provider = "first";
    const calls: Array<{ provider: string; params: LlmStreamParams }> = [];
    const rows: string[] = [];
    const recorders = new Map<string, TraceRecorder>();
    const health: MemoryHealthAnnouncer = { observe: (sessionId, kind, outcome) => rows.push(`health:${sessionId}:${kind}:${outcome}`) };
    services = createRuntimeMemoryServices({ ...dependencies(async (params) => { calls.push({ provider, params }); return completion(); }), slotManager: { sideCallSlotId: () => slot }, touchRecorder: (id) => recorders.get(id), memoryHealth: health });
    expect(calls).toEqual([]);
    const runner = services.reflectionRunner;
    if (!runner) throw new Error("Reflection should be wired");
    for (const id of ["first-session", "second-session"]) recorders.set(id, createTraceRecorder({ sessionId: id, emit: (event) => rows.push(`trace:${event.sessionId}:${event.type}`) }));
    await runner.reflect({ sessionId: "first-session", userMessage: "Remember my preference", assistantReply: "Understood" });
    provider = "second"; slot = 3;
    await runner.reflect({ sessionId: "second-session", userMessage: "Remember my other preference", assistantReply: "Understood" });
    expect(calls.map((call) => [call.provider, call.params.sessionId, call.params.slotId])).toEqual([["first", "reflection:first-session", 1], ["second", "reflection:second-session", 3]]);
    expect(rows).toEqual(["trace:first-session:reflection", "health:first-session:reflection:none", "trace:second-session:reflection", "health:second-session:reflection:none"]);
  });

  it("forwards separate signals and session cancellation leaves a sibling reflection alive", async () => {
    const calls: LlmStreamParams[] = [];
    const pending = new Map<string, (result: CompletionResult) => void>();
    services = createRuntimeMemoryServices(dependencies((params) => {
      calls.push(params); return new Promise((resolve) => pending.set(params.sessionId ?? "missing", resolve));
    }));
    const runner = services.reflectionRunner;
    if (!runner) throw new Error("Reflection should be wired");
    const first = runner.reflect({ sessionId: "one", userMessage: "Remember a preference", assistantReply: "OK" });
    const second = runner.reflect({ sessionId: "two", userMessage: "Remember a preference", assistantReply: "OK" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal); expect(calls[0]?.signal).not.toBe(calls[1]?.signal);
    runner.abortPending({ sessionId: "one" });
    await first;
    expect(calls[0]?.signal?.aborted).toBe(true); expect(calls[1]?.signal?.aborted).toBe(false);
    pending.get("reflection:two")?.(completion()); await second;
  });

  it("keeps reflection, link generation and voting ordered on the same late side slot", async () => {
    config.memory.links.enabled = true; config.memory.links.autoGenerate = true;
    config.memory.links.minCandidates = 2; config.memory.voting.enabled = true;
    stores.voteStore = new VoteStore({ db: stores.notesStore.getDatabaseHandleForEmbeddings() });
    const a = stores.notesStore.store({ content: "Team uses a deployment checklist", tags: [] });
    const b = stores.notesStore.store({ content: "The release checklist requires a backup", tags: [] });
    const calls: LlmStreamParams[] = []; let slot = 1;
    services = createRuntimeMemoryServices({ ...dependencies(async (params) => { calls.push(params); return completion(); }), slotManager: { sideCallSlotId: () => slot } });
    slot = 7;
    await services.reflectionRunner?.reflect({ sessionId: "curator", userMessage: "Remember the team process", assistantReply: "OK", recalledMemoryIds: [a.id, b.id] });
    expect(calls.map((params) => [params.sessionId, params.slotId])).toEqual([["reflection:curator", 7], ["link-gen:curator", 7], ["vote:curator", 7]]);
    for (const call of calls) expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(stores.voteStore.getEventCount()).toBe(0);
  });

  it("wires the rewriter into real recall with its isolated session, response format and late slot", async () => {
    config.memory.retrieve.rewriter.enabled = true; config.memory.retrieve.rewriter.gateMode = "always";
    config.memory.recallInjection.enabled = true;
    const stored = stores.notesStore.store({ content: "Alpha database backup location is the deployment folder", tags: [] });
    const calls: LlmStreamParams[] = []; let slot = 2;
    services = createRuntimeMemoryServices({ ...dependencies(async (params) => { calls.push(params); return completion('<rewritten_query>alpha</rewritten_query>'); }), slotManager: { sideCallSlotId: () => slot } });
    slot = 4;
    const context = await services.memoryContextProvider?.buildMemoryContext({ sessionId: "reader", userMessage: "Where was that?", signal: new AbortController().signal, recentTurns: [{ role: "user", text: "Tell me about the Alpha deployment" }, { role: "assistant", text: "The backup is there" }] });
    expect(calls).toHaveLength(1); expect(calls[0]?.sessionId).toBe("rewriter:reader"); expect(calls[0]?.slotId).toBe(4);
    expect(calls[0]?.responseFormat).toMatchObject({ name: "query_rewriter_v1", strict: true, schema: { type: "object" } });
    expect(context?.recalled.map((note) => note.id)).toContain(stored.id);
  });

  it("creates a consolidator without starting its scoped timer and keeps cold-path trace sequence across ticks", async () => {
    config.memory.lessons.enabled = true; config.memory.consolidation.enabled = true;
    config.memory.procedures.enabled = false;
    config.memory.consolidation.cooldownMs = 0; config.memory.consolidation.minClusterSize = 2;
    config.memory.consolidation.requireSharedTag = false; config.memory.consolidation.maxClustersPerTick = 1;
    const a = stores.notesStore.store({ content: "Back up the deployment database before starting a restart", tags: ["deployment"] }, Date.now() - 1_000_000);
    const b = stores.notesStore.store({ content: "Application release failed without a recent backup", tags: ["deployment"] }, Date.now() - 1_000_000);
    stores.linkStore.add({ fromId: a.id, toId: b.id, kind: "RELATES_TO", weight: 0.9 });
    config.memory.lessons.deprecationAgeMs = 1_000;
    const obsolete = stores.lessonStore.create({ activation: "When using the retired release process", principle: "This advice is obsolete", tags: [], parentIds: [a.id] });
    stores.notesStore.getDatabaseHandleForEmbeddings().prepare("UPDATE lessons SET created_at = ? WHERE id = ?").run(Date.now() - 5_000, obsolete.id);
    const events: TraceEvent[] = []; const calls: LlmStreamParams[] = []; let slot = 2;
    const interval = vi.spyOn(globalThis, "setInterval");
    job = createRuntimeMemoryConsolidator({ ...dependencies(async (params) => { calls.push(params); return completion('LESSON activation="When deploying applications"; principle="Create a database backup before restarting."; tags=deployment'); }), slotManager: { sideCallSlotId: () => slot }, traceBus: { emit: (event) => events.push(event) } });
    expect(interval).not.toHaveBeenCalled();
    if (!job) throw new Error("Consolidator should be wired");
    slot = 5;
    const result = await job.runOnce();
    expect(result.lessonsCreated).toBe(1);
    expect(calls[0]?.slotId).toBe(5); expect(calls[0]?.sessionId).toBe("consolidator");
    expect(events.filter((event) => event.type === "distill")).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId: "consolidator", seq: 0, type: "distill" });
    expect(events.find((event) => event.type === "lesson_deprecated")).toMatchObject({ sessionId: "consolidator", lessonId: obsolete.id });
    // A second cluster gets the same per-runtime job/sequence, without starting background work.
    const c = stores.notesStore.store({ content: "Keep local migration recovery instructions for outages", tags: ["recovery"] }, Date.now() - 1_000_000);
    const d = stores.notesStore.store({ content: "Recovery procedures should be tested before a release", tags: ["recovery"] }, Date.now() - 1_000_000);
    stores.linkStore.add({ fromId: c.id, toId: d.id, kind: "RELATES_TO", weight: 0.9 });
    await job.runOnce();
    expect(events.filter((event) => event.type === "distill").map((event) => event.seq)).toEqual([0, 2]);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2]);
    job.start(); expect(interval).toHaveBeenCalledTimes(1); job.stop();
  });
});
