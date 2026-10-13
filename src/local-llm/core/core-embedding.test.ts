import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPendingEmbeddingDisable, connectCore, CoreRequestError, ensureCore, type CoreControlClient } from "./core-client.js";
import {
  chooseUpstreamEngine,
  coreEmbeddingRecordPath,
  coreEmbeddingStatus,
  coreEmbeddingTimeoutMs,
  createCoreEmbeddingClient,
  readCoreEmbeddingRecord,
  startCoreEmbedding,
  startCoreEmbeddingOn,
  stopCoreEmbedding,
  type CoreEmbeddingStatus,
} from "./core-embedding.js";
import { retireIdleCore } from "./core-sessions.js";
import { CORE_VERSION, coreRoot, writeCoreJson } from "./core-state.js";
import { EmbeddingUnavailableError } from "../../memory/embeddings/embedding-client.js";

const fake = vi.hoisted(() => ({ call: vi.fn(), downloadEvents: vi.fn(), snapshot: vi.fn() }));
vi.mock("./core-client.js", async importOriginal => ({
  ...(await importOriginal<typeof import("./core-client.js")>()),
  connectCore: vi.fn(async () => null),
  ensureCore: vi.fn(),
  withCoreClient: async (_d: string, _v: string, fn: (client: typeof fake) => Promise<unknown>) => fn(fake),
}));
vi.mock("./core-sessions.js", () => ({ retireIdleCore: vi.fn(async () => false) }));
const client = fake as unknown as CoreControlClient;

let dir: string;
beforeEach(() => {
  vi.resetAllMocks();
  dir = mkdtempSync(join(tmpdir(), "core-embedding-"));
  vi.mocked(connectCore).mockResolvedValue(null);
  vi.mocked(retireIdleCore).mockResolvedValue(false);
  fake.downloadEvents.mockResolvedValue(async () => {});
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ready: CoreEmbeddingStatus = {
  state: "ready", enabled: true, model_path: "/m/embeddinggemma-2-Q8_0.gguf", model_id: "embeddinggemma-2",
  engine: { path: "/b/llama-server", version_backend: "b11460/macos-arm64", provider: "llamacpp-upstream" },
  pid: 4242, port: 39001, dims: 768, modalities: ["text"], restarts: 0, error: null, since: 0,
};
const record = (change: object = {}) =>
  writeCoreJson(coreEmbeddingRecordPath(dir), { coreVersion: CORE_VERSION, modelId: "embeddinggemma-2", modelPath: "/m.gguf", ...change });
const disable = ["/embedding/config", { enabled: false }, { method: "PUT", timeoutMs: 30_000 }];

describe("chooseUpstreamEngine", () => {
  const min = 11454;
  it("uses an installed build at or above the floor that Core lists as available here", () => {
    expect(chooseUpstreamEngine({
      available: [{ version: "b11460", backend: "macos-arm64" }, { version: "b11500", backend: "macos-arm64" }],
      installed: [{ version: "b11400", backend: "macos-arm64" }, { version: "b11460", backend: "macos-arm64" }, { version: "b11500", backend: "win-cuda-13.1-x64" }],
      recommended: "b11500/macos-arm64",
    }, min)).toEqual({ kind: "installed", version: "b11460", backend: "macos-arm64" });
  });
  it("trusts Core's hardware gate: family ids in supported_backends do not drop concrete CUDA builds", () => {
    expect(chooseUpstreamEngine({
      supported_backends: ["win-cuda-13-x64", "win-vulkan-x64", "win-cpu-x64"],
      installed: [],
      recommended: "b11470/win-cuda-13.1-x64",
      available: [{ version: "b11470", backend: "win-cuda-13.1-x64" }, { version: "b11470", backend: "win-vulkan-x64" }],
    }, min)).toEqual({ kind: "install", version: "b11470", backend: "win-cuda-13.1-x64" });
    expect(chooseUpstreamEngine({
      supported_backends: ["linux-cuda-13-arm64"],
      recommended: "b11400/linux-cuda-13.1-arm64",
      available: [{ version: "b11460", backend: "linux-cpu-arm64" }, { version: "b11460", backend: "linux-cuda-13.1-arm64" }],
    }, min)).toEqual({ kind: "install", version: "b11460", backend: "linux-cuda-13.1-arm64" });
  });
  it("ignores an installed build Core does not offer for this hardware", () => {
    expect(chooseUpstreamEngine({
      installed: [{ version: "b11500", backend: "win-cuda-13.1-x64" }],
      available: [{ version: "b11460", backend: "win-vulkan-x64" }],
      recommended: "b11460/win-vulkan-x64",
    }, min)).toEqual({ kind: "install", version: "b11460", backend: "win-vulkan-x64" });
  });
  it("otherwise installs the newest available build, the recommended kind first", () => {
    expect(chooseUpstreamEngine({
      recommended: "b11400/win-vulkan-x64",
      available: [
        { version: "b11460", backend: "win-cpu-x64" },
        { version: "b11460", backend: "win-vulkan-x64" },
        { version: "b11455", backend: "win-vulkan-x64" },
        { version: "b11400", backend: "win-vulkan-x64" },
        { version: "latest", backend: "win-vulkan-x64" },
      ],
    }, min)).toEqual({ kind: "install", version: "b11460", backend: "win-vulkan-x64" });
  });
  it("reports none when nothing reaches the floor", () => {
    expect(chooseUpstreamEngine({ recommended: "b11000/ubuntu-x64", available: [{ version: "b11453", backend: "ubuntu-x64" }] }, min)).toEqual({ kind: "none" });
    expect(chooseUpstreamEngine({}, min)).toEqual({ kind: "none" });
  });
});

describe("createCoreEmbeddingClient", () => {
  const prompts = { query: "task: search result | query: ", document: "title: none | text: ", similarity: "task: sentence similarity | query: " };
  const vector = Array.from({ length: 768 }, (_, i) => i / 768);

  it("sends the prompted text and returns the vector", async () => {
    fake.call.mockResolvedValue({ status: 200, body: { data: [{ embedding: vector }] } });
    const embedder = createCoreEmbeddingClient({ dataDir: dir, dim: 768, model: "embeddinggemma-2", prompts, connect: async () => client });
    const out = await embedder.embed({ text: "where is my config", purpose: "query" });
    expect(out.vector).toBeInstanceOf(Float32Array);
    expect(out.vector).toHaveLength(768);
    expect(out.model).toBe("embeddinggemma-2");
    expect(fake.call).toHaveBeenCalledWith("/embedding/embed", { model: "embeddinggemma-2", input: "task: search result | query: where is my config" }, expect.objectContaining({ timeoutMs: 15_000 }));
    await embedder.embed({ text: "a note", purpose: "document" });
    expect(fake.call.mock.calls[1]?.[1]).toEqual({ model: "embeddinggemma-2", input: "title: none | text: a note" });
    expect(fake.call.mock.calls[1]?.[2]).toMatchObject({ timeoutMs: 130_000 });
    await embedder.embed({ text: "plain" });
    expect(fake.call.mock.calls[2]?.[1]).toEqual({ model: "embeddinggemma-2", input: "plain" });
  });

  it("gives a background write room for Core's cold start, and keeps turn-path calls short", () => {
    expect(coreEmbeddingTimeoutMs("document")).toBeGreaterThan(120_000);
    expect(coreEmbeddingTimeoutMs(undefined)).toBeGreaterThan(120_000);
    expect(coreEmbeddingTimeoutMs("query")).toBe(15_000);
    expect(coreEmbeddingTimeoutMs("similarity")).toBe(15_000);
  });

  it("treats an engine error answer as unavailable", async () => {
    fake.call.mockResolvedValue({ status: 500, body: { error: { message: "context overflow" } } });
    const embedder = createCoreEmbeddingClient({ dataDir: dir, dim: 768, model: "embeddinggemma-2", connect: async () => client });
    await expect(embedder.embed({ text: "x" })).rejects.toThrow(EmbeddingUnavailableError);
    await expect(embedder.embed({ text: "x" })).rejects.toThrow("HTTP 500: context overflow");
  });

  it("refuses a vector of another length", async () => {
    fake.call.mockResolvedValue({ status: 200, body: { data: [{ embedding: [0.1, 0.2] }] } });
    const embedder = createCoreEmbeddingClient({ dataDir: dir, dim: 768, model: "embeddinggemma-2", connect: async () => client });
    await expect(embedder.embed({ text: "x" })).rejects.toThrow(/dim mismatch: expected 768, got 2/);
  });

  it("turns a transport failure into EmbeddingUnavailableError and reconnects on the next call", async () => {
    const connect = vi.fn(async () => client);
    fake.call.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue({ status: 200, body: { data: [{ embedding: vector }] } });
    const embedder = createCoreEmbeddingClient({ dataDir: dir, dim: 768, model: "embeddinggemma-2", connect });
    await expect(embedder.embed({ text: "x" })).rejects.toThrow(EmbeddingUnavailableError);
    await expect(embedder.embed({ text: "x" })).resolves.toMatchObject({ model: "embeddinggemma-2" });
    await embedder.embed({ text: "x" });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("is unavailable, never starting Core, when Core is not running", async () => {
    const embedder = createCoreEmbeddingClient({ dataDir: dir, dim: 768, model: "embeddinggemma-2", connect: async () => null });
    await expect(embedder.embed({ text: "x" })).rejects.toThrow(EmbeddingUnavailableError);
    expect(fake.call).not.toHaveBeenCalled();
  });
});

describe("starting the module", () => {
  const opts = { modelId: "embeddinggemma-2", modelPath: "/m/embeddinggemma-2-Q8_0.gguf" };

  it("configures the model, then loads it", async () => {
    fake.call.mockImplementation(async (path: string) => (path === "/embedding/load" ? ready : {}));
    await expect(startCoreEmbeddingOn(client, opts)).resolves.toMatchObject({ state: "ready", dims: 768 });
    expect(fake.call.mock.calls[0]).toEqual(["/embedding/config", {
      enabled: true, model_path: opts.modelPath, model_id: "embeddinggemma-2", mmproj_path: "", ctx_size: 2048, pooling: "",
    }, { method: "PUT" }]);
    expect(fake.call.mock.calls[1]?.[0]).toBe("/embedding/load");
  });

  it("installs a new enough llama.cpp build when Core has none, then loads again", async () => {
    let loads = 0;
    const onEngineInstall = vi.fn();
    fake.call.mockImplementation(async (path: string) => {
      if (path === "/embedding/load") {
        if (++loads === 1) throw new CoreRequestError(409, "No installed llama.cpp build can run the embedding model.", "EMBEDDING_ENGINE_UNSUPPORTED");
        return ready;
      }
      if (path === "/backends/llamacpp-upstream/catalog") return { recommended: "b11470/macos-arm64", installed: [], available: [{ version: "b11470", backend: "macos-arm64" }] };
      if (path === "/backends/llamacpp-upstream/install") return { path: "/b" };
      return {};
    });
    await expect(startCoreEmbeddingOn(client, { ...opts, onEngineInstall })).resolves.toMatchObject({ state: "ready" });
    expect(onEngineInstall).toHaveBeenCalledTimes(1);
    const install = fake.call.mock.calls.find(([path]) => path === "/backends/llamacpp-upstream/install");
    expect(install?.[1]).toMatchObject({ version: "b11470", backend: "macos-arm64" });
    expect(loads).toBe(2);
  });

  it("says Core refused an installed build instead of a retry hint that loops", async () => {
    fake.call.mockImplementation(async (path: string) => {
      if (path === "/embedding/load") throw new CoreRequestError(409, "No installed llama.cpp build can run the embedding model.", "EMBEDDING_ENGINE_UNSUPPORTED");
      if (path === "/backends/llamacpp-upstream/catalog") return { installed: [{ version: "b11470", backend: "macos-arm64" }], available: [{ version: "b11470", backend: "macos-arm64" }] };
      return {};
    });
    const err = await startCoreEmbedding(dir, opts).catch((e: unknown) => e as Error);
    expect(err.message).toContain("Atomic Core refused llama.cpp b11470/macos-arm64");
    expect(err.message).not.toContain("start-embedding");
    expect(fake.call.mock.calls.some(([path]) => path === "/backends/llamacpp-upstream/install")).toBe(false);
  });

  it("turns the module off and names the pull command when the file is missing", async () => {
    fake.call.mockImplementation(async (path: string) => {
      if (path === "/embedding/load") throw new CoreRequestError(404, "The embedding model does not exist.", "MODEL_FILE_NOT_FOUND");
      return {};
    });
    await expect(startCoreEmbedding(dir, opts)).rejects.toThrow("atomic-agent models pull-embedding embeddinggemma-2");
    expect(fake.call).toHaveBeenLastCalledWith(...disable);
    expect(existsSync(coreEmbeddingRecordPath(dir))).toBe(false);
  });

  it("keeps the record with the disable pending when Core will not turn a failed start off", async () => {
    fake.call.mockImplementation(async (path: string, body?: { enabled?: boolean }) => {
      if (path === "/embedding/load") throw new CoreRequestError(500, "boom", "MODEL_LOAD_FAILED");
      if (path === "/embedding/config" && body?.enabled === false) throw new CoreRequestError(503, "busy");
      return {};
    });
    await expect(startCoreEmbedding(dir, opts)).rejects.toThrow("could not start the embedding model: boom");
    expect(readCoreEmbeddingRecord(dir)).toMatchObject({ modelId: "embeddinggemma-2", disablePending: true });
  });

  it("records a started module and forgets a failed one", async () => {
    fake.call.mockImplementation(async (path: string) => (path === "/embedding/load" ? ready : {}));
    await startCoreEmbedding(dir, opts);
    expect(readCoreEmbeddingRecord(dir)).toMatchObject({ coreVersion: CORE_VERSION, modelId: "embeddinggemma-2" });
    fake.call.mockImplementation(async (path: string) => {
      if (path === "/embedding/load") throw new CoreRequestError(500, "boom", "MODEL_LOAD_FAILED");
      return {};
    });
    await expect(startCoreEmbedding(dir, opts)).rejects.toThrow("could not start the embedding model: boom");
    expect(existsSync(coreEmbeddingRecordPath(dir))).toBe(false);
  });

  it("refuses to run the module on an older active Core it cannot switch", async () => {
    writeCoreJson(join(coreRoot(dir), "active.json"), { version: "0.11.2" });
    await expect(startCoreEmbedding(dir, opts)).rejects.toThrow(`needs Atomic Core ${CORE_VERSION}. Install it with: atomic-agent models update`);
    expect(fake.call).not.toHaveBeenCalled();
  });
});

describe("stopping and status", () => {
  it("does nothing for a module this agent never started", async () => {
    await expect(stopCoreEmbedding(dir)).resolves.toBe(false);
    await expect(coreEmbeddingStatus(dir)).resolves.toBeNull();
    expect(connectCore).not.toHaveBeenCalled();
    expect(ensureCore).not.toHaveBeenCalled();
  });

  it("turns the module off on the running Core, forgets it, then lets an idle Core retire", async () => {
    record();
    vi.mocked(connectCore).mockResolvedValue(client);
    fake.call.mockResolvedValue({});
    await expect(stopCoreEmbedding(dir)).resolves.toBe(true);
    expect(fake.call).toHaveBeenCalledWith(...disable);
    expect(existsSync(coreEmbeddingRecordPath(dir))).toBe(false);
    expect(retireIdleCore).toHaveBeenCalledWith(dir);
  });

  it("honours a short wait for Core's answer, never below five seconds", async () => {
    record();
    vi.mocked(connectCore).mockResolvedValue(client);
    fake.call.mockResolvedValue({});
    await stopCoreEmbedding(dir, { waitMs: 4_000, retire: false });
    expect(fake.call).toHaveBeenCalledWith("/embedding/config", { enabled: false }, { method: "PUT", timeoutMs: 5_000 });
    expect(retireIdleCore).not.toHaveBeenCalled();
  });

  it("never starts a stopped Core: the disable waits for the next Core start", async () => {
    record();
    await expect(stopCoreEmbedding(dir)).resolves.toBe(true);
    expect(ensureCore).not.toHaveBeenCalled();
    expect(fake.call).not.toHaveBeenCalled();
    expect(retireIdleCore).not.toHaveBeenCalled();
    expect(readCoreEmbeddingRecord(dir)).toMatchObject({ disablePending: true });
    await expect(coreEmbeddingStatus(dir)).resolves.toBeNull();

    // The next Core start (ensureCore) applies it.
    fake.call.mockResolvedValue({});
    await applyPendingEmbeddingDisable(dir, CORE_VERSION, client);
    expect(fake.call).toHaveBeenCalledWith(...disable);
    expect(existsSync(coreEmbeddingRecordPath(dir))).toBe(false);
  });

  it("keeps the disable pending when Core refuses it, and the stop says so", async () => {
    record();
    vi.mocked(connectCore).mockResolvedValue(client);
    fake.call.mockRejectedValue(new CoreRequestError(503, "busy"));
    await expect(stopCoreEmbedding(dir)).rejects.toThrow("retried at the next engine start");
    expect(readCoreEmbeddingRecord(dir)).toMatchObject({ disablePending: true });
    await applyPendingEmbeddingDisable(dir, CORE_VERSION, client);
    expect(readCoreEmbeddingRecord(dir)).toMatchObject({ disablePending: true });
  });

  it("leaves a record without a pending disable alone on Core start", async () => {
    record();
    await applyPendingEmbeddingDisable(dir, CORE_VERSION, client);
    expect(fake.call).not.toHaveBeenCalled();
    expect(existsSync(coreEmbeddingRecordPath(dir))).toBe(true);
  });

  it("reads status from the recorded Core without starting it", async () => {
    record();
    await expect(coreEmbeddingStatus(dir)).resolves.toBeNull();
    vi.mocked(connectCore).mockResolvedValue(client);
    fake.call.mockResolvedValue(ready);
    await expect(coreEmbeddingStatus(dir)).resolves.toMatchObject({ state: "ready", dims: 768 });
    expect(ensureCore).not.toHaveBeenCalled();
  });
});
