import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../local-llm/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../local-llm/index.js")
  >("../../local-llm/index.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(),
    // Never the real one: it would stop or move whatever holds this machine's port.
    reclaimManagedPort: vi.fn(async () => ({ kind: "free" })),
    fetchServedModelIds: vi.fn(async () => null),
    getEmbeddingDaemonStatus: vi.fn(),
    startEmbeddingDaemon: vi.fn(),
    stopEmbeddingDaemon: vi.fn(),
    startChatAndEmbeddingDaemons: vi.fn(),
    resolveManagedDevice: vi.fn(),
    listVulkanDevices: vi.fn(),
    probeNvidiaVramMiB: vi.fn(),
    maybeAutoUpdateBackend: vi.fn(),
  };
});

// The machine's real memory never decides these tests.
vi.mock("../../memory/embeddings/embedding-memory-check.js", async () => ({
  ...(await vi.importActual<typeof import("../../memory/embeddings/embedding-memory-check.js")>(
    "../../memory/embeddings/embedding-memory-check.js",
  )),
  checkEmbeddingModelMemory: vi.fn(),
}));

import { getConfig, resetConfigCache } from "../../config/index.js";
import { getUserConfigPath, readUserConfigFileSync } from "../../config/config-file.js";
import * as localLlm from "../../local-llm/index.js";
import {
  getEmbeddingModelDef,
  resolveBackendDir,
  resolveModelFilePath,
  resolveServerBinPath,
} from "../../local-llm/index.js";
import { resolvePlatformAsset } from "../../local-llm/backend/platform-assets.js";
import { checkEmbeddingModelMemory } from "../../memory/embeddings/embedding-memory-check.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import { persistEmbeddingHybridRecall } from "../persist-embedding-hybrid-recall.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

const EMBED_MODEL_ID = "bge-m3";
const CHAT_MODEL_ID = "qwen-3.5-4b";
const NOTE = "Memory search uses keywords: not enough free memory for the memory model (needs ~600 MB).";

type Emitted = { type: string; line?: string };

/**
 * ATO-379: on a machine short of memory the TUI does not start the
 * embedding model. Memory search stays on keywords, the operator gets one
 * note per session, and the hybrid-recall opt-in stays on disk so the
 * model starts once memory allows.
 */
describe("LocalModelsOrchestrator embedding start on low memory", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-models-lowmem-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    vi.mocked(localLlm.getDaemonStatus).mockReset();
    vi.mocked(localLlm.getEmbeddingDaemonStatus).mockReset();
    vi.mocked(localLlm.startEmbeddingDaemon).mockReset().mockResolvedValue({ pid: 5151 });
    vi.mocked(localLlm.stopEmbeddingDaemon).mockReset();
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockReset().mockImplementation(async (opts) => ({
      chat: { pid: 4242 },
      embedding: opts.embedding ? { pid: 5151 } : { skipped: true },
    }) as Awaited<ReturnType<typeof localLlm.startChatAndEmbeddingDaemons>>);
    vi.mocked(localLlm.resolveManagedDevice).mockReset().mockResolvedValue(undefined);
    vi.mocked(localLlm.listVulkanDevices).mockReset().mockResolvedValue([]);
    vi.mocked(localLlm.probeNvidiaVramMiB).mockReset().mockResolvedValue(null);
    vi.mocked(localLlm.maybeAutoUpdateBackend).mockReset().mockResolvedValue({ action: "skipped" });
    vi.mocked(checkEmbeddingModelMemory).mockReset().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function lowMemory(): void {
    vi.mocked(checkEmbeddingModelMemory).mockResolvedValue({
      ok: false,
      reason: "available",
      note: NOTE,
      detail: "0.4 GB available, needs 1.3 GB",
    });
  }

  function makeOrchestrator(): { orchestrator: LocalModelsOrchestrator; lines: () => string[] } {
    const actions: Emitted[] = [];
    const orchestrator = new LocalModelsOrchestrator({
      emit(a: unknown) {
        actions.push(a as Emitted);
      },
      subscribe: () => () => {},
    });
    vi.spyOn(orchestrator, "refresh").mockResolvedValue();
    return { orchestrator, lines: () => actions.map((a) => a.line ?? "").filter(Boolean) };
  }

  function readFlag(): boolean {
    return readUserConfigFileSync(getUserConfigPath(stateDir)).memory.embeddings.enabled;
  }

  /** A chat daemon left running by a previous session: `autoStartIfReady` adopts it and pairs the embedding side. */
  function chatAlreadyRunning(): void {
    prepareInstall();
    vi.mocked(localLlm.getDaemonStatus).mockResolvedValue({ running: true, healthy: true, loading: false, pid: 1234, port: 19091 });
    vi.mocked(localLlm.getEmbeddingDaemonStatus).mockResolvedValue({ running: false, healthy: false, loading: false, pid: null, port: 19092 });
  }

  it("does not start the embedding model beside a running chat model, and says so once", async () => {
    chatAlreadyRunning();
    lowMemory();
    const { orchestrator, lines } = makeOrchestrator();

    await orchestrator.autoStartIfReady();
    await orchestrator.autoStartIfReady();

    expect(localLlm.startEmbeddingDaemon).not.toHaveBeenCalled();
    expect(checkEmbeddingModelMemory).toHaveBeenCalledWith(getEmbeddingModelDef(EMBED_MODEL_ID).fileSizeGb);
    expect(lines().filter((l) => l.includes("Memory search uses keywords"))).toEqual([`local-llm: ${NOTE}`]);
    expect(lines().some((l) => l.includes("starting embedding daemon"))).toBe(false);
    // The opt-in stays: the model starts once memory allows.
    expect(readFlag()).toBe(true);
  });

  it("starts it as before when there is enough memory", async () => {
    chatAlreadyRunning();
    const { orchestrator, lines } = makeOrchestrator();

    await orchestrator.autoStartIfReady();

    expect(localLlm.startEmbeddingDaemon).toHaveBeenCalledTimes(1);
    expect(lines().some((l) => l.includes("Memory search uses keywords"))).toBe(false);
  });

  it("does not check memory when the embedding model already runs", async () => {
    chatAlreadyRunning();
    vi.mocked(localLlm.getEmbeddingDaemonStatus).mockResolvedValue({ running: true, healthy: true, loading: false, pid: 5678, port: 19092 });
    lowMemory();
    const { orchestrator, lines } = makeOrchestrator();

    await orchestrator.autoStartIfReady();

    expect(checkEmbeddingModelMemory).not.toHaveBeenCalled();
    expect(localLlm.startEmbeddingDaemon).not.toHaveBeenCalled();
    expect(lines().some((l) => l.includes("Memory search uses keywords"))).toBe(false);
  });

  it("starts the chat model alone when the pair starts together, with the note instead of 'not on disk'", async () => {
    prepareInstall();
    vi.mocked(localLlm.getDaemonStatus).mockResolvedValue({ running: false, healthy: false, loading: false, pid: null, port: 19091 });
    vi.mocked(localLlm.getEmbeddingDaemonStatus).mockResolvedValue({ running: false, healthy: false, loading: false, pid: null, port: 19092 });
    lowMemory();
    const { orchestrator, lines } = makeOrchestrator();

    await expect(orchestrator.startDaemon({ backendAlreadyChecked: true })).resolves.toBe(true);

    const call = vi.mocked(localLlm.startChatAndEmbeddingDaemons).mock.calls[0]![0];
    expect(call.chat.modelId).toBe(CHAT_MODEL_ID);
    expect(call.embedding).toBeUndefined();
    expect(lines().filter((l) => l.includes("Memory search uses keywords"))).toEqual([`local-llm: ${NOTE}`]);
    expect(lines().some((l) => l.includes("not on disk"))).toBe(false);
    expect(readFlag()).toBe(true);
  });

  it("starts both together as before when there is enough memory", async () => {
    prepareInstall();
    vi.mocked(localLlm.getDaemonStatus).mockResolvedValue({ running: false, healthy: false, loading: false, pid: null, port: 19091 });
    vi.mocked(localLlm.getEmbeddingDaemonStatus).mockResolvedValue({ running: false, healthy: false, loading: false, pid: null, port: 19092 });
    const { orchestrator } = makeOrchestrator();

    await expect(orchestrator.startDaemon({ backendAlreadyChecked: true })).resolves.toBe(true);

    expect(vi.mocked(localLlm.startChatAndEmbeddingDaemons).mock.calls[0]![0].embedding).toMatchObject({ modelId: EMBED_MODEL_ID });
  });
});

/** llama.cpp engine installed, chat + embedding models on disk, hybrid recall opted in. */
function prepareInstall(): void {
  const dataDir = getConfig().paths.localModelsDataDir;
  mkdirSync(resolveBackendDir(dataDir), { recursive: true });
  const { binaryName } = resolvePlatformAsset();
  writeFileSync(resolveServerBinPath(dataDir, binaryName), "");
  const chat = localLlm.getLocalModelDef(CHAT_MODEL_ID);
  mkdirSync(join(dataDir, "models", chat.id), { recursive: true });
  writeFileSync(resolveModelFilePath(dataDir, chat.id, chat.filename), "stub");
  const emb = getEmbeddingModelDef(EMBED_MODEL_ID);
  mkdirSync(join(dataDir, "models", emb.id), { recursive: true });
  writeFileSync(resolveModelFilePath(dataDir, emb.id, emb.filename), "stub");
  persistUserLocalModelsConfig({
    mode: "managed",
    // These tests cover the llama.cpp engine; Atomic Core is the default since config v77.
    managed: { engine: "llama-server", modelId: CHAT_MODEL_ID },
    embeddings: { enabled: true, modelId: EMBED_MODEL_ID },
  });
  persistEmbeddingHybridRecall({ enabled: true, modelId: EMBED_MODEL_ID });
  resetConfigCache();
}
