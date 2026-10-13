import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectCore, CoreRequestError, ensureCore, type CoreControlClient } from "./core-client.js";
import {
  chooseUpstreamEngine,
  coreEmbeddingRecordPath,
  coreEmbeddingStatus,
  createCoreEmbeddingClient,
  startCoreEmbedding,
  startCoreEmbeddingOn,
  stopCoreEmbedding,
  type CoreEmbeddingStatus,
} from "./core-embedding.js";
import { CORE_VERSION, writeCoreJson } from "./core-state.js";
import { EmbeddingUnavailableError } from "../../memory/embeddings/embedding-client.js";

const fake = vi.hoisted(() => ({ call: vi.fn(), downloadEvents: vi.fn(), snapshot: vi.fn() }));
vi.mock("./core-client.js", async importOriginal => ({
  ...(await importOriginal<typeof import("./core-client.js")>()),
  connectCore: vi.fn(async () => null),
  ensureCore: vi.fn(),
  withCoreClient: async (_d: string, _v: string, fn: (client: typeof fake) => Promise<unknown>) => fn(fake),
}));
const client = fake as unknown as CoreControlClient;

let dir: string;
beforeEach(() => {
  vi.resetAllMocks();
  dir = mkdtempSync(join(tmpdir(), "core-embedding-"));
  vi.mocked(connectCore).mockResolvedValue(null);
  fake.downloadEvents.mockResolvedValue(async () => {});
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ready: CoreEmbeddingStatus = {
  state: "ready", enabled: true, model_path: "/m/embeddinggemma-2-Q8_0.gguf", model_id: "embeddinggemma-2",
  engine: { path: "/b/llama-server", version_backend: "b11460/macos-arm64", provider: "llamacpp-upstream" },
  pid: 4242, port: 39001, dims: 768, modalities: ["text"], restarts: 0, error: null, since: 0,
};

describe("chooseUpstreamEngine", () => {
  const min = 11454;
  it("uses an installed build at or above the floor that this computer runs", () => {
    expect(chooseUpstreamEngine({
      supported_backends: ["macos-arm64"],
      installed: [{ version: "b11400", backend: "macos-arm64" }, { version: "b11460", backend: "macos-arm64" }, { version: "b11500", backend: "win-cuda-x64" }],
      recommended: "b11500/macos-arm64",
    }, min)).toEqual({ kind: "installed", version: "b11460", backend: "macos-arm64" });
  });
  it("installs Core's recommendation when it is new enough", () => {
    expect(chooseUpstreamEngine({
      supported_backends: ["win-vulkan-x64", "win-cpu-x64"],
      installed: [{ version: "b11400", backend: "win-vulkan-x64" }],
      recommended: "b11470/win-vulkan-x64",
    }, min)).toEqual({ kind: "install", version: "b11470", backend: "win-vulkan-x64" });
  });
  it("otherwise installs the newest available build, the recommended kind first", () => {
    expect(chooseUpstreamEngine({
      supported_backends: ["win-vulkan-x64", "win-cpu-x64"],
      recommended: "b11400/win-vulkan-x64",
      available: [
        { version: "b11460", backend: "win-cpu-x64" },
        { version: "b11460", backend: "win-vulkan-x64" },
        { version: "b11455", backend: "win-vulkan-x64" },
        { version: "b11400", backend: "win-vulkan-x64" },
        { version: "b99999", backend: "win-cuda-13-x64" },
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
    expect(fake.call).toHaveBeenCalledWith("/embedding/embed", { model: "embeddinggemma-2", input: "task: search result | query: where is my config" }, expect.objectContaining({ timeoutMs: 30_000 }));
    await embedder.embed({ text: "a note", purpose: "document" });
    expect(fake.call.mock.calls[1]?.[1]).toEqual({ model: "embeddinggemma-2", input: "title: none | text: a note" });
    await embedder.embed({ text: "plain" });
    expect(fake.call.mock.calls[2]?.[1]).toEqual({ model: "embeddinggemma-2", input: "plain" });
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
      if (path === "/backends/llamacpp-upstream/catalog") return { supported_backends: ["macos-arm64"], recommended: "b11470/macos-arm64", installed: [] };
      if (path === "/backends/llamacpp-upstream/install") return { path: "/b" };
      return {};
    });
    await expect(startCoreEmbeddingOn(client, { ...opts, onEngineInstall })).resolves.toMatchObject({ state: "ready" });
    expect(onEngineInstall).toHaveBeenCalledTimes(1);
    const install = fake.call.mock.calls.find(([path]) => path === "/backends/llamacpp-upstream/install");
    expect(install?.[1]).toMatchObject({ version: "b11470", backend: "macos-arm64" });
    expect(loads).toBe(2);
  });

  it("turns the module off and names the pull command when the file is missing", async () => {
    fake.call.mockImplementation(async (path: string) => {
      if (path === "/embedding/load") throw new CoreRequestError(404, "The embedding model does not exist.", "MODEL_FILE_NOT_FOUND");
      return {};
    });
    await expect(startCoreEmbeddingOn(client, opts)).rejects.toThrow("atomic-agent models pull-embedding embeddinggemma-2");
    expect(fake.call).toHaveBeenLastCalledWith("/embedding/config", { enabled: false }, { method: "PUT", timeoutMs: 30_000 });
  });

  it("records a started module and forgets a failed one", async () => {
    fake.call.mockImplementation(async (path: string) => (path === "/embedding/load" ? ready : {}));
    await startCoreEmbedding(dir, opts);
    expect(existsSync(coreEmbeddingRecordPath(dir))).toBe(true);
    fake.call.mockImplementation(async (path: string) => {
      if (path === "/embedding/load") throw new CoreRequestError(500, "boom", "MODEL_LOAD_FAILED");
      return {};
    });
    await expect(startCoreEmbedding(dir, opts)).rejects.toThrow("could not start the embedding model: boom");
    expect(existsSync(coreEmbeddingRecordPath(dir))).toBe(false);
  });
});

describe("stopping and status", () => {
  const record = () => writeCoreJson(coreEmbeddingRecordPath(dir), { coreVersion: CORE_VERSION, modelId: "embeddinggemma-2", modelPath: "/m.gguf" });

  it("does nothing for a module this agent never started", async () => {
    await expect(stopCoreEmbedding(dir)).resolves.toBe(false);
    await expect(coreEmbeddingStatus(dir)).resolves.toBeNull();
    expect(connectCore).not.toHaveBeenCalled();
    expect(ensureCore).not.toHaveBeenCalled();
  });

  it("turns the module off on the running Core and forgets it", async () => {
    record();
    vi.mocked(connectCore).mockResolvedValue(client);
    fake.call.mockResolvedValue({});
    await expect(stopCoreEmbedding(dir)).resolves.toBe(true);
    expect(fake.call).toHaveBeenCalledWith("/embedding/config", { enabled: false }, { method: "PUT", timeoutMs: 30_000 });
    expect(existsSync(coreEmbeddingRecordPath(dir))).toBe(false);
  });

  it("starts a stopped Core to turn the module off, so it does not come back at Core's next launch", async () => {
    record();
    vi.mocked(ensureCore).mockResolvedValue(client);
    fake.call.mockResolvedValue({});
    await expect(stopCoreEmbedding(dir)).resolves.toBe(true);
    expect(ensureCore).toHaveBeenCalledWith(dir, CORE_VERSION);
    expect(fake.call).toHaveBeenCalledWith("/embedding/config", { enabled: false }, { method: "PUT", timeoutMs: 30_000 });
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
