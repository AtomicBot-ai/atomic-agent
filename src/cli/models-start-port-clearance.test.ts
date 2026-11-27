import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../local-llm/index.js", async () => ({
  ...(await vi.importActual<typeof import("../local-llm/index.js")>("../local-llm/index.js")),
  maybeAutoUpdateBackend: vi.fn(),
  resolveManagedDevice: vi.fn(),
  startChatAndEmbeddingDaemons: vi.fn(),
  reclaimManagedPort: vi.fn(),
}));

vi.mock("../analytics/index.js", async () => ({
  ...(await vi.importActual<typeof import("../analytics/index.js")>("../analytics/index.js")),
  reportLocalEngineFailed: vi.fn(async () => {}),
}));

import { getUserConfigPath, writeUserConfigFileSync } from "../config/config-file.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import { getConfig, resetConfigCache } from "../config/index.js";
import * as localLlm from "../local-llm/index.js";
import { PortTakenError, resolvePidFilePath } from "../local-llm/index.js";
import { runLocalModelsStart } from "./models-handlers.js";
import { clearChatPortForStart } from "./models-start-port-clearance.js";

const MODEL = "qwen-3.5-4b";

/**
 * ATO-2458: `models start` (the desktop's start) clears its port the way
 * the TUI does, but never moves it: a moved port is saved to config,
 * which the desktop's agent process does not re-read (ATO-1750).
 */
describe("models start port clearance", () => {
  let stateDir: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-models-reclaim-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
        mode: "managed",
        managed: { ...USER_CONFIG_DEFAULTS.localModels.managed, engine: "llama-server", modelId: MODEL },
        embeddings: { ...USER_CONFIG_DEFAULTS.localModels.embeddings, enabled: false },
      },
    });
    resetConfigCache();
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => (out.push(String(c)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => (err.push(String(c)), true));
    vi.mocked(localLlm.maybeAutoUpdateBackend).mockReset().mockResolvedValue({ action: "current", tag: "b1" } as never);
    vi.mocked(localLlm.resolveManagedDevice).mockReset().mockResolvedValue(undefined);
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockReset();
    vi.mocked(localLlm.reclaimManagedPort).mockReset().mockResolvedValue({ kind: "free" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  const reclaimCalls = () => vi.mocked(localLlm.reclaimManagedPort).mock.calls.map(([req]) => req);

  it("stops our own wedged server on the port, then starts on the same port", async () => {
    const port = getConfig().localModels.managed.port;
    vi.mocked(localLlm.reclaimManagedPort).mockResolvedValue({
      kind: "stopped",
      pid: 46051,
      why: "stopped a leftover llama-server pid 46051 (llama-server)",
    });
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockResolvedValue({
      chat: { pid: 777 },
      embedding: { skipped: true },
    } as never);

    await expect(runLocalModelsStart()).resolves.toBe(0);

    expect(reclaimCalls()).toEqual([expect.objectContaining({ role: "chat", port, alias: MODEL, move: false })]);
    expect(localLlm.startChatAndEmbeddingDaemons).toHaveBeenCalledTimes(1);
    expect(vi.mocked(localLlm.startChatAndEmbeddingDaemons).mock.calls[0]![0].chat.port).toBe(port);
    expect(out.join("")).toContain("chat: stopped a leftover llama-server pid 46051");
    expect(out.join("")).toMatch(/^chat: started pid 777, healthy on port /m);
  });

  it("takes back our own server already serving the model instead of launching a second one", async () => {
    vi.mocked(localLlm.reclaimManagedPort).mockResolvedValue({ kind: "adopted", pid: 61655 });

    await expect(runLocalModelsStart()).resolves.toBe(0);

    expect(localLlm.startChatAndEmbeddingDaemons).not.toHaveBeenCalled();
    // The desktop's ready line (backend-switch readyLine) reads only this shape.
    expect(out.join("")).toMatch(/^chat: started pid 61655, healthy on port \d+ \(our server was already running\)$/m);
  });

  it("a one-start --ctx-size launches with that window and never adopts", async () => {
    vi.mocked(localLlm.reclaimManagedPort).mockResolvedValue({ kind: "adopted", pid: 61655 });
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockResolvedValue({
      chat: { pid: 778 },
      embedding: { skipped: true },
    } as never);

    await expect(runLocalModelsStart({ contextSize: 4096 })).resolves.toBe(0);

    expect(localLlm.reclaimManagedPort).not.toHaveBeenCalled();
    expect(localLlm.startChatAndEmbeddingDaemons).toHaveBeenCalledTimes(1);
    expect(vi.mocked(localLlm.startChatAndEmbeddingDaemons).mock.calls[0]![0].chat.contextSize).toBe(4096);
    expect(out.join("")).toMatch(/^chat: started pid 778, healthy on port /m);
  });

  it("leaves a stranger on the port: the PortTakenError stays and the config port is unchanged", async () => {
    const cfgPath = getUserConfigPath(stateDir);
    const before = readFileSync(cfgPath, "utf-8");
    const port = getConfig().localModels.managed.port;
    vi.mocked(localLlm.reclaimManagedPort).mockResolvedValue({
      kind: "held",
      why: `port ${port} is held by pid 9 (LM Studio), which is not an atomic-agent server`,
    });
    vi.mocked(localLlm.startChatAndEmbeddingDaemons).mockRejectedValue(new PortTakenError(port, ["other-model"]));

    await expect(runLocalModelsStart()).resolves.toBe(1);

    expect(err.join("")).toContain(`port ${port} is already served by another process (model other-model)`);
    expect(readFileSync(cfgPath, "utf-8")).toBe(before);
    resetConfigCache();
    expect(getConfig().localModels.managed.port).toBe(port);
    // The move branch is never asked for from `models start`.
    expect(reclaimCalls().every((req) => req.move === false)).toBe(true);
  });

  it("asks nothing when our daemon is already recorded: the start's own refusal stays", async () => {
    const cfg = getConfig();
    const pidPath = resolvePidFilePath(cfg.paths.localModelsDataDir);
    mkdirSync(dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, String(process.pid), "utf-8");
    const reclaim = vi.fn(async () => ({ kind: "free" }) as const);

    expect(await clearChatPortForStart(cfg, MODEL, reclaim)).toBeNull();
    expect(reclaim).not.toHaveBeenCalled();
  });

  it("a reclaim that throws leaves the launch to report the port", async () => {
    const reclaim = vi.fn(async () => {
      throw new Error("lsof failed");
    });
    expect(await clearChatPortForStart(getConfig(), MODEL, reclaim)).toBeNull();
  });
});
