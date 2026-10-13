import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfigCache } from "../../config/index.js";
import type { AtomicAgentConfig } from "../../config/config-schema.js";
import { AgentMetrics, METRIC_NAMES } from "../../tracing/agent-metrics.js";
import { MetricsCollector, type MetricSample } from "../../tracing/metrics-collector.js";
import * as health from "../../llm/llama-server-health.js";
import * as embeddings from "../../memory/embeddings/local-embedding-client.js";
import { LlamaEmbeddingClient, type EmbeddingClient } from "../../memory/embeddings/embedding-client.js";
import { EmbeddingStore } from "../../memory/embeddings/embedding-store.js";
import { EmbeddingWriter } from "../../memory/embeddings/embedding-writer.js";
import { MemoryStore } from "../../memory/memory-store.js";
import { createRuntimeMemoryStores, probeCoreEmbedding, startEmbeddingBackfill, type RuntimeMemoryStores } from "./runtime-memory-stores.js";
import type { CoreEmbeddingStatus } from "../../local-llm/core/core-embedding.js";

let dir: string;
let config: AtomicAgentConfig;
let stores: RuntimeMemoryStores | undefined;
let previous: Map<string, string | undefined>;
const samples: MetricSample[] = [];
const metrics = new AgentMetrics(new MetricsCollector({ sinks: [(sample) => samples.push(sample)] }));
const unexpected = (): never => { throw new Error("No network or model invocation in store composition tests"); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-memory-stores-"));
  previous = new Map();
  for (const key of Object.keys(process.env)) if (key.startsWith("ATOMIC_AGENT_")) { previous.set(key, process.env[key]); delete process.env[key]; }
  if (!previous.has("ATOMIC_AGENT_STATE_DIR")) previous.set("ATOMIC_AGENT_STATE_DIR", undefined);
  process.env.ATOMIC_AGENT_STATE_DIR = dir;
  resetConfigCache(); config = loadConfig();
  config.paths.memoryDbFile = join(dir, "memory.sqlite");
  config.memory.embeddings.enabled = false;
  config.localModels.embeddings.enabled = false;
  samples.length = 0; stores = undefined;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await stores?.embeddingBackfill?.stop();
  if (stores) {
    // Four connections have runtime ownership; wrappers borrow notesStore's connection.
    stores.profileStore.close(); stores.lessonStore.close(); stores.procedureStore.close(); stores.notesStore.close();
  }
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  resetConfigCache(); rmSync(dir, { recursive: true, force: true });
});
function enabledEmbedding(): void {
  config.memory.embeddings.enabled = true;
  config.localModels.embeddings.enabled = true;
  config.localModels.embeddings.modelId = "nomic-embed-text-v1.5";
}
function healthSamples() { return samples.filter((sample) => sample.name === METRIC_NAMES.memoryEmbeddingsDaemonHealth); }

describe("runtime memory stores construction", () => {
  it("creates owned stores even when features are disabled, while borrowed wrappers share only the notes handle", async () => {
    config.memory.profile.enabled = false; config.memory.notes.enabled = false;
    config.memory.lessons.enabled = false; config.memory.procedures.enabled = false;
    config.memory.voting.enabled = true;
    const probe = vi.spyOn(health, "checkLlamaServer").mockImplementation(async () => unexpected());
    stores = await createRuntimeMemoryStores({ config, metrics, onProfileEvicted: unexpected });
    expect(probe).not.toHaveBeenCalled();
    expect(stores.embeddingHealth).toBe("disabled"); expect(stores.embeddingClient).toBeNull();
    expect(healthSamples()).toMatchObject([{ tags: { outcome: "disabled" } }]);
    const db = stores.notesStore.getDatabaseHandleForEmbeddings();
    stores.profileStore.set("present", "profile still exists");
    expect(stores.notesStore.count()).toBe(0);
    expect(stores.linkStore.listAll()).toEqual([]);
    expect(stores.voteStore?.getEventCount()).toBe(0);
    // Closing one independently owned connection must not close the others or the borrowed connection.
    stores.profileStore.close(); stores.lessonStore.close(); stores.procedureStore.close();
    expect(db.open).toBe(true); expect(stores.notesStore.count()).toBe(0);
    expect(stores.linkStore.listAll()).toEqual([]); expect(stores.voteStore?.getEventCount()).toBe(0);
    stores.notesStore.close();
    expect(db.open).toBe(false);
    expect(() => stores?.linkStore.listAll()).toThrow();
    expect(() => stores?.voteStore?.getEventCount()).toThrow();
    stores = undefined;
  });

  it("awaits embedding health and attachment before constructing the remaining stores", async () => {
    enabledEmbedding(); config.memory.voting.enabled = true;
    const order: string[] = [];
    const profileCap = config.memory.profile.maxEntries;
    const notesCap = config.memory.notes.maxEntries;
    const lessonCap = config.memory.lessons.maxEntries;
    const procedureCap = config.memory.procedures.maxEntries;
    Object.defineProperty(config.memory.profile, "maxEntries", { get: () => { order.push("profile"); return profileCap; } });
    Object.defineProperty(config.memory.notes, "maxEntries", { get: () => { order.push("notes"); return notesCap; } });
    Object.defineProperty(config.memory.lessons, "maxEntries", { get: () => { order.push("lessons"); return lessonCap; } });
    Object.defineProperty(config.memory.procedures, "maxEntries", { get: () => { order.push("procedures"); return procedureCap; } });
    let release!: (value: Awaited<ReturnType<typeof health.checkLlamaServer>>) => void;
    const probe = vi.spyOn(health, "checkLlamaServer").mockImplementation(() => {
      order.push("probe"); return new Promise((resolve) => { release = resolve; });
    });
    const client = new LlamaEmbeddingClient({ model: "nomic-embed-text-v1.5", dim: 768, url: "http://127.0.0.1:1" });
    vi.spyOn(client, "embed").mockImplementation(async () => unexpected());
    const createClient = vi.spyOn(embeddings, "createLocalEmbeddingClient").mockImplementation(() => { order.push("client"); return client; });
    const originalAttach = MemoryStore.prototype.attachEmbeddings;
    const attach = vi.spyOn(MemoryStore.prototype, "attachEmbeddings").mockImplementation(function(this: MemoryStore, args) { order.push("attach"); originalAttach.call(this, args); });
    const pending = createRuntimeMemoryStores({ config, metrics, onProfileEvicted: unexpected });
    expect(order).toEqual(["profile", "notes", "probe"]);
    release({ reachable: true, status: 200, kind: "llama-server", error: null, latencyMs: 1 });
    stores = await pending;
    expect(order).toEqual(["profile", "notes", "probe", "client", "attach", "lessons", "procedures"]);
    expect(probe).toHaveBeenCalledWith({ url: config.localModels.embeddings.url, retries: 0, backoffMs: 0, timeoutMs: 2000 });
    expect(createClient).toHaveBeenCalledWith({ url: config.localModels.embeddings.url, dim: 768, model: "nomic-embed-text-v1.5" });
    expect(attach).toHaveBeenCalledTimes(1);
    expect(stores.embeddingClient).toBe(client); expect(stores.embeddingHealth).toBe("ok");
    expect(healthSamples()).toMatchObject([{ tags: { outcome: "ok", model: "nomic-embed-text-v1.5" } }]);
  });

  it.each(["unreachable", "rejected", "construction"])("keeps usable FTS5 stores when optional embeddings are %s", async (failure) => {
    enabledEmbedding();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const probe = vi.spyOn(health, "checkLlamaServer");
    if (failure === "rejected") probe.mockRejectedValue(new Error("probe unavailable"));
    else probe.mockResolvedValue({ reachable: failure === "construction", status: 200, kind: "llama-server", error: null, latencyMs: 1 });
    const client = vi.spyOn(embeddings, "createLocalEmbeddingClient").mockImplementation(() => { throw new Error("invalid constructor"); });
    stores = await createRuntimeMemoryStores({ config, metrics, onProfileEvicted: unexpected });
    expect(stores.embeddingHealth).toBe("unreachable"); expect(stores.embeddingClient).toBeNull();
    expect(stores.notesStore.store({ content: "Durable FTS5 fallback", tags: [] }).id).toBeGreaterThan(0);
    expect(stores.notesStore.recall("fallback")).toHaveLength(1);
    expect(stores.lessonStore.listIndex()).toEqual([]); expect(stores.procedureStore.listIndex()).toEqual([]);
    expect(client).toHaveBeenCalledTimes(failure === "construction" ? 1 : 0);
    expect(stderr).toHaveBeenCalled();
    expect(healthSamples()).toMatchObject([{ tags: { outcome: "unreachable", model: "nomic-embed-text-v1.5" } }]);
  });

  it("retains the already-created client when a later embedding attachment fails", async () => {
    enabledEmbedding();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(health, "checkLlamaServer").mockResolvedValue({ reachable: true, status: 200, kind: "llama-server", error: null, latencyMs: 1 });
    const client = new LlamaEmbeddingClient({ model: "nomic-embed-text-v1.5", dim: 768, url: "http://127.0.0.1:1" });
    vi.spyOn(client, "embed").mockImplementation(async () => unexpected());
    vi.spyOn(embeddings, "createLocalEmbeddingClient").mockReturnValue(client);
    vi.spyOn(MemoryStore.prototype, "attachEmbeddings").mockImplementation(() => { throw new Error("attachment rejected"); });
    stores = await createRuntimeMemoryStores({ config, metrics, onProfileEvicted: unexpected });
    // The original bootstrap assigns the client before attachment; preserving that identity is intentional.
    expect(stores.embeddingHealth).toBe("unreachable"); expect(stores.embeddingClient).toBe(client);
    expect(stores.notesStore.count()).toBe(0); expect(stores.linkStore.listAll()).toEqual([]);
  });

  it("calls the injected eviction hook inside the current owning session context", async () => {
    config.memory.profile.maxEntries = 1;
    const context = new AsyncLocalStorage<{ sessionId: string }>();
    const events: Array<{ sessionId: string | undefined; count: number }> = [];
    stores = await createRuntimeMemoryStores({ config, metrics, onProfileEvicted: (event) => events.push({ sessionId: context.getStore()?.sessionId, count: event.evicted.length }) });
    context.run({ sessionId: "first" }, () => stores?.profileStore.set("first", "one", { pinned: false }));
    context.run({ sessionId: "second" }, () => stores?.profileStore.set("second", "two", { pinned: false }));
    expect(events).toEqual([{ sessionId: "second", count: 1 }]);
  });
});

describe("embedding backfill wiring", () => {
  function seedNotes(...contents: string[]): void {
    const seed = new MemoryStore({ dbFile: config.paths.memoryDbFile, maxEntries: 100 });
    try { for (const content of contents) seed.store({ content }); } finally { seed.close(); }
  }
  async function bootWithClient(): Promise<RuntimeMemoryStores> {
    enabledEmbedding();
    vi.spyOn(health, "checkLlamaServer").mockResolvedValue({ reachable: true, status: 200, kind: "llama-server", error: null, latencyMs: 1 });
    const client = new LlamaEmbeddingClient({ model: "nomic-embed-text-v1.5", dim: 768, url: "http://127.0.0.1:1" });
    vi.spyOn(client, "embed").mockImplementation(async () => unexpected());
    vi.spyOn(embeddings, "createLocalEmbeddingClient").mockReturnValue(client);
    return createRuntimeMemoryStores({ config, metrics, onProfileEvicted: unexpected });
  }

  it("starts in the background when notes lack a vector, and stops before its first embed when shut down early", async () => {
    seedNotes("an older note");
    stores = await bootWithClient();
    expect(stores.embeddingHealth).toBe("ok");
    expect(stores.embeddingBackfill).not.toBeNull();
    // A short-lived runtime (`run`, `task run`) shuts down inside the start delay: nothing is embedded.
    await stores.embeddingBackfill?.stop();
    await expect(stores.embeddingBackfill?.done).resolves.toBeNull();
  });

  it("does not start when memory.embeddings.backfill is off", async () => {
    seedNotes("an older note");
    config.memory.embeddings.backfill = false;
    stores = await bootWithClient();
    expect(stores.embeddingHealth).toBe("ok");
    expect(stores.embeddingBackfill).toBeNull();
  });

  it("does not start when every note already has a vector, nor without embeddings", async () => {
    stores = await bootWithClient();
    expect(stores.embeddingBackfill).toBeNull();
    stores.profileStore.close(); stores.lessonStore.close(); stores.procedureStore.close(); stores.notesStore.close();
    vi.restoreAllMocks();
    seedNotes("a note");
    config.memory.embeddings.enabled = false;
    stores = await createRuntimeMemoryStores({ config, metrics, onProfileEvicted: unexpected });
    expect(stores.embeddingBackfill).toBeNull();
  });

  it("embeds the pending notes after the delay and logs one line at start and one at the end", async () => {
    seedNotes("first", "second");
    const notes = new MemoryStore({ dbFile: config.paths.memoryDbFile, maxEntries: 100 });
    try {
      const db = notes.getDatabaseHandleForEmbeddings();
      const client: EmbeddingClient = { dim: 2, model: "fake", embed: async () => ({ vector: new Float32Array([1, 0]), model: "fake" }) };
      const writer = new EmbeddingWriter({ client, store: new EmbeddingStore({ db }) });
      const lines: Array<[string, unknown]> = [];
      const handle = startEmbeddingBackfill({ db, writer, logger: { info: (message, context) => lines.push([message, context]) }, startDelayMs: 0, pauseMs: 0 });
      await expect(handle?.done).resolves.toEqual({ model: "fake", embedded: 2, skipped: 0, remaining: 0 });
      expect(lines).toEqual([
        ["memory embeddings backfill started", { model: "fake", pending: 2 }],
        ["memory embeddings backfill finished", { model: "fake", embedded: 2, skipped: 0, remaining: 0 }],
      ]);
      expect(startEmbeddingBackfill({ db, writer, startDelayMs: 0 })).toBeNull();
    } finally {
      notes.close();
    }
  });
});

describe("probeCoreEmbedding", () => {
  const def = { id: "embeddinggemma-2", name: "EmbeddingGemma 2", dim: 768 };
  const status = (change: Partial<CoreEmbeddingStatus>): CoreEmbeddingStatus => ({
    state: "ready", enabled: true, model_path: "/m.gguf", model_id: def.id, engine: null, pid: 1, port: 2,
    dims: 768, modalities: ["text"], restarts: 0, error: null, since: 0, ...change,
  });
  const probe = (st: CoreEmbeddingStatus | null) => probeCoreEmbedding("/data", def, async () => st);

  it("attaches a ready module of the catalog's dimension, and an idle one (the first request starts it)", async () => {
    await expect(probe(status({}))).resolves.toEqual({ reachable: true });
    await expect(probe(status({ state: "idle", dims: null }))).resolves.toEqual({ reachable: true });
  });
  it("never attaches a module whose vectors have another length", async () => {
    await expect(probe(status({ dims: 1024 }))).resolves.toMatchObject({ reachable: false, why: expect.stringContaining("1024-dim") });
  });
  it.each<[string, CoreEmbeddingStatus | null]>([
    ["Core not running", null],
    ["module off", status({ enabled: false, state: "disabled" })],
    ["another model", status({ model_id: "other" })],
    ["failed", status({ state: "failed", error: { code: "MODEL_LOAD_FAILED", message: "boom" } })],
    ["no engine", status({ state: "unsupported" })],
  ])("falls back to FTS5 when %s", async (_label, st) => {
    await expect(probe(st)).resolves.toMatchObject({ reachable: false });
  });
});
