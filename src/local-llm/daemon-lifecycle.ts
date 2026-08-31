import { execSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import {
  resolveEmbeddingLogFilePath,
  resolveEmbeddingPidFilePath,
  resolveLogFilePath,
  resolveModelFilePath,
  resolvePidFilePath,
  resolveServerBinPath,
} from "./backend-paths.js";
import {
  estimateContextSize,
  resolveDeviceFreeVramMiB,
} from "./context-size.js";
import { listVulkanDevices, resolveManagedDevice } from "./gpu-devices.js";
import {
  getEmbeddingModelDef,
  getLocalModelDef,
  type EmbeddingModelId,
  type LocalModelId,
} from "./models-catalog.js";
import { resolvePlatformAsset } from "./platform-assets.js";

export interface DaemonStartOptions {
  dataDir: string;
  modelId: LocalModelId;
  port: number;
  chatTemplateFile?: string;
  /**
   * Absolute path to the model's mmproj projector GGUF. When set,
   * `--mmproj <path>` is appended to the llama-server invocation so
   * the server boots with multimodal support. The caller is
   * responsible for verifying the projector file exists on disk —
   * `startDaemon` does not re-check, only forwards the flag. Leave
   * undefined for text-only operation.
   */
  mmprojFile?: string;
  /**
   * Resolved compute device for offloading. A concrete backend device
   * id (e.g. `Vulkan0`) appends `--device <id>`; the literal `"cpu"`
   * forces CPU-only by overriding `-ngl` to `0`; `undefined` leaves the
   * llama.cpp default device selection in place (legacy behavior).
   * `startDaemon` resolves the configured preference (`auto` / id /
   * `cpu`) through `resolveManagedDevice` before building args, so a
   * value passed here is treated as an explicit override.
   */
  device?: string;
  /**
   * Operator override for the llama-server context window
   * (`localModels.managed.contextSize`). `0` / `undefined` means
   * auto-size: `startDaemon` fits the context to the target device's
   * free VRAM (see `estimateContextSize`). A positive value pins
   * `--ctx-size` exactly (clamped to the model's trained ceiling).
   */
  contextSize?: number;
  /**
   * Multi-GPU ratios (`localModels.managed.tensorSplit`). A non-empty
   * list appends `--split-mode layer --tensor-split <r0,r1,…>` so the
   * model's layers spread across GPUs proportionally, and switches the
   * `auto` device resolution from "pin the best single GPU" to "leave
   * every GPU visible" (see `resolveManagedDevice`). Ignored when the
   * device resolves to `"cpu"` — nothing is offloaded, so there is
   * nothing to split. Empty / undefined keeps the single-device launch
   * byte-identical.
   */
  tensorSplit?: readonly number[];
}

/**
 * Build the full llama-server CLI argv for a managed-mode launch.
 * Pure function — no IO, no spawn, no path validation. Extracted from
 * `startDaemon` so the flag set is unit-testable without touching
 * `child_process`. Order is load-bearing for grep-ability of historical
 * log lines: do not reshuffle existing flags when adding new ones.
 */
export function buildLlamaServerArgs(
  opts: DaemonStartOptions,
  modelPath: string,
  modelAlias: string,
  effectiveContextSize?: number,
): string[] {
  const args = [
    "--no-webui",
    "--jinja",
    "-m",
    modelPath,
    "--port",
    String(opts.port),
    "--host",
    "127.0.0.1",
    "-ngl",
    opts.device === "cpu" ? "0" : "-1",
    "--flash-attn",
    "auto",
    "--cache-type-k",
    "turbo3",
    "--cache-type-v",
    "turbo3",
    "--parallel",
    "2",
    "-kvu",
    "-a",
    modelAlias,
  ];
  if (effectiveContextSize && effectiveContextSize > 0) {
    args.push("--ctx-size", String(effectiveContextSize));
  }
  if (opts.device && opts.device !== "cpu") {
    args.push("--device", opts.device);
  }
  if (opts.device !== "cpu" && opts.tensorSplit && opts.tensorSplit.length > 0) {
    args.push("--split-mode", "layer", "--tensor-split", opts.tensorSplit.join(","));
  }
  if (opts.chatTemplateFile) {
    args.push("--chat-template-file", opts.chatTemplateFile);
  }
  if (opts.mmprojFile) {
    args.push("--mmproj", opts.mmprojFile);
    // Vision-capable models (notably Gemma-4 with `gemma4v` projector and
    // Qwen3-VL with `qwen3vl_merger`) hallucinate image content when the
    // image-token budget defaults to ~70 tokens — clip produces a near-noise
    // embedding and the LLM confabulates. The minimum useful budget for
    // general-purpose multimodal chat is 560 tokens (Unsloth's published
    // Gemma-4 budget tiers: 70/140/280/560/1120). Gemma-4's vision encoder
    // also uses non-causal attention, which requires every image_tokens
    // batch to fit in a single ubatch — bumping `--ubatch-size` to 1024
    // and `--batch-size` to 2048 keeps that constraint satisfied without
    // crashing on the GGML_ASSERT in llama-context.cpp.
    args.push(
      "--image-min-tokens",
      "560",
      "--image-max-tokens",
      "560",
      "--ubatch-size",
      "1024",
      "--batch-size",
      "2048",
    );
  }
  return args;
}

/**
 * Resolve the effective `--ctx-size` for a chat daemon launch. Impure
 * glue around the pure `estimateContextSize`: when auto-sizing on a GPU
 * device it enumerates `--list-devices` to read the target device's free
 * VRAM. Best-effort — any enumeration failure degrades to the no-VRAM
 * default. Skips the probe entirely when the operator pinned a value or
 * offload is CPU-only.
 */
async function resolveEffectiveContextSize(
  binPath: string,
  device: string | undefined,
  model: { fileSizeGb: number; maxContextLength: number; mmprojFileSizeGb?: number },
  opts: { configured: number; hasMmproj: boolean },
): Promise<number> {
  let freeVramMiB: number | null = null;
  if (opts.configured <= 0 && device && device !== "cpu") {
    const devices = await listVulkanDevices(binPath);
    freeVramMiB = resolveDeviceFreeVramMiB(devices, device);
  }
  return estimateContextSize({
    freeVramMiB,
    modelSizeGb: model.fileSizeGb,
    mmprojSizeGb: opts.hasMmproj ? (model.mmprojFileSizeGb ?? 0) : 0,
    maxContextLength: model.maxContextLength,
    configuredContextSize: opts.configured,
  });
}

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  port: number;
  healthy: boolean;
  loading: boolean;
}

export async function probeLlamaHealth(
  port: number,
  signal?: AbortSignal,
): Promise<"ok" | "loading" | "down"> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: signal ?? AbortSignal.timeout(2000),
    });
    const body = (await res.json().catch(() => null)) as { status?: string } | null;
    if (res.ok && body?.status === "ok") return "ok";
    if (body?.status === "loading model") return "loading";
    return res.ok ? "ok" : "down";
  } catch {
    return "down";
  }
}

/**
 * Thrown by `stopDaemon` / `stopEmbeddingDaemon` when the recorded pid
 * belongs to a live process owned by another user (e.g. the daemon was
 * started via sudo/root and the stop call now runs as a regular user).
 * We cannot signal such a process, and silently dropping its pid file
 * would orphan a live GPU process while making the status indicator
 * report it as stopped — so the stop path surfaces this instead.
 */
export class ForeignDaemonError extends Error {
  constructor(public readonly pid: number) {
    super(
      `cannot stop llama-server pid ${pid}: process is owned by another user — ` +
        `re-run as that user (or with sudo), or stop it manually`,
    );
    this.name = "ForeignDaemonError";
  }
}

/**
 * Classify a recorded pid via signal 0. `process.kill(pid, 0)` throws
 * ESRCH when the process is gone and EPERM when it is alive but owned
 * by another user, so the two failure modes must not be conflated:
 *   - `alive`   — the process exists and we can signal it.
 *   - `foreign` — the process exists but is owned by another user.
 *   - `dead`    — no such process (or any other probe failure).
 */
export function classifyPidLiveness(pid: number): "alive" | "foreign" | "dead" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "EPERM" ? "foreign" : "dead";
  }
}

export function readRunningPid(
  dataDir: string,
  role: "chat" | "embedding" = "chat",
): number | null {
  const pidPath =
    role === "embedding"
      ? resolveEmbeddingPidFilePath(dataDir)
      : resolvePidFilePath(dataDir);
  let raw: string;
  try {
    raw = readFileSync(pidPath, "utf-8").trim();
  } catch {
    return null;
  }
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0) {
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
    return null;
  }
  // Only ESRCH ("dead") drops the pid file. A `foreign` process (alive,
  // owned by another user) is still running, so its tracking must stay —
  // otherwise the status indicator would report a healthy daemon as
  // stopped (we also have no right to unlink its pid file).
  if (classifyPidLiveness(pid) === "dead") {
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
    return null;
  }
  return pid;
}

/**
 * Thrown when a spawned llama-server never reached a healthy `/health`
 * within the deadline — the process crashed on startup or could not
 * load the model. Typed (rather than a bare `Error`) so the Windows
 * CPU-backend fallback can distinguish "the installed compute backend
 * cannot serve on this machine" from pre-spawn failures like a missing
 * model file, which no backend swap would fix.
 */
export class DaemonHealthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonHealthError";
  }
}

async function waitForHealthOkWithLog(dataDir: string, port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await probeLlamaHealth(port);
    if (r === "ok") return;
    await new Promise((r2) => setTimeout(r2, 500));
  }
  let tail = "";
  try {
    const logPath = resolveLogFilePath(dataDir);
    const buf = readFileSync(logPath, "utf-8");
    tail = buf.length > 4096 ? buf.slice(-4096) : buf;
  } catch {
    tail = "(no log)";
  }
  throw new DaemonHealthError(
    `llama-server did not become healthy within ${timeoutMs}ms. Log tail:\n${tail}`,
  );
}

export async function startDaemon(opts: DaemonStartOptions): Promise<{ pid: number }> {
  const pidPath = resolvePidFilePath(opts.dataDir);
  const existing = readRunningPid(opts.dataDir);
  if (existing !== null) {
    throw new Error(`already running at pid ${existing}`);
  }

  const { binaryName } = resolvePlatformAsset();
  const binPath = resolveServerBinPath(opts.dataDir, binaryName);
  if (!existsSync(binPath)) {
    throw new Error("backend not downloaded; run 'atomic-agent models update'");
  }

  const model = getLocalModelDef(opts.modelId);
  const modelPath = resolveModelFilePath(opts.dataDir, model.id, model.filename);
  if (!existsSync(modelPath)) {
    throw new Error(
      `model ${opts.modelId} not downloaded; run 'atomic-agent models pull ${opts.modelId}'`,
    );
  }

  // A configured tensor split flips `auto` device resolution to "leave
  // every GPU visible" — pinning one `--device` would defeat the split.
  // With no pinned device the context auto-sizer has no single VRAM
  // figure to probe and degrades to its conservative no-VRAM default;
  // operators splitting across GPUs can pin `contextSize` explicitly.
  const device = await resolveManagedDevice(binPath, opts.device, {
    multiGpu: (opts.tensorSplit?.length ?? 0) > 0,
  });
  const contextSize = await resolveEffectiveContextSize(binPath, device, model, {
    configured: opts.contextSize ?? 0,
    hasMmproj: Boolean(opts.mmprojFile),
  });
  const args = buildLlamaServerArgs(
    { ...opts, device },
    modelPath,
    model.id,
    contextSize,
  );

  const logFd = openSync(resolveLogFilePath(opts.dataDir), "a");
  try {
    const child = spawn(binPath, args, {
      stdio: ["ignore", logFd, logFd],
      detached: true,
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
      env: { ...process.env },
    });
    child.unref();
    if (child.pid == null) {
      throw new Error("spawn failed: no pid");
    }
    writeFileSync(pidPath, String(child.pid), "utf-8");
    await waitForHealthOkWithLog(opts.dataDir, opts.port, 30_000);
    return { pid: child.pid };
  } finally {
    closeSync(logFd);
  }
}

export async function stopDaemon(
  dataDir: string,
  opts?: { timeoutMs?: number },
): Promise<void> {
  const pidPath = resolvePidFilePath(dataDir);
  let raw: string;
  try {
    raw = readFileSync(pidPath, "utf-8").trim();
  } catch {
    return;
  }
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0) {
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
    return;
  }

  const liveness = classifyPidLiveness(pid);
  if (liveness === "dead") {
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
    return;
  }
  if (liveness === "foreign") {
    throw new ForeignDaemonError(pid);
  }

  const timeoutMs = opts?.timeoutMs ?? 3000;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { timeout: 5000, stdio: "ignore" });
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }

  try {
    unlinkSync(pidPath);
  } catch {
    /* ignore */
  }
}

export async function getDaemonStatus(dataDir: string, port: number): Promise<DaemonStatus> {
  const pid = readRunningPid(dataDir);
  const h = await probeLlamaHealth(port);
  return {
    running: pid !== null,
    pid,
    port,
    healthy: h === "ok",
    loading: h === "loading",
  };
}

// ---------------------------------------------------------------------
// Memory-v2 phase 1B. Second daemon dedicated to `/embedding`.
//
// We deliberately keep this as a parallel pair of functions rather
// than parameterising `startDaemon` over a `DaemonRole` enum. The
// flag set, model resolution, and pid/log file names diverge enough
// that an `if (role === "embedding") ...` ladder inside `startDaemon`
// would be more confusing than two narrow functions sharing the few
// genuinely common helpers (`waitForHealthOkWithLog`, `probeLlamaHealth`).
// ---------------------------------------------------------------------

export interface EmbeddingDaemonStartOptions {
  dataDir: string;
  modelId: EmbeddingModelId;
  port: number;
  /**
   * Resolved compute device for the embedding daemon. Same semantics as
   * `DaemonStartOptions.device` — a concrete id appends `--device`,
   * `"cpu"` forces `-ngl 0`, `undefined` keeps the llama.cpp default.
   * `startEmbeddingDaemon` resolves the configured preference so both
   * daemons land on the same chosen GPU.
   */
  device?: string;
}

/**
 * Build the argv for an embedding-only `llama-server`. The `--embeddings`
 * flag plus `--pooling <kind>` are load-bearing — without `--pooling`
 * llama.cpp returns per-token embeddings, which is not what callers of
 * `/embedding` expect. `--ctx-size 2048` is plenty for the kind of
 * short memory snippets the writer feeds in; raising it inflates
 * RAM-per-slot without any quality win for sub-document inputs.
 */
export function buildEmbeddingServerArgs(
  opts: EmbeddingDaemonStartOptions,
  modelPath: string,
): string[] {
  const model = getEmbeddingModelDef(opts.modelId);
  const args = [
    "--no-webui",
    "-m",
    modelPath,
    "--port",
    String(opts.port),
    "--host",
    "127.0.0.1",
    "-ngl",
    opts.device === "cpu" ? "0" : "-1",
    "--embeddings",
    "--pooling",
    model.pooling,
    "--ctx-size",
    "2048",
    "-a",
    model.id,
  ];
  if (opts.device && opts.device !== "cpu") {
    args.push("--device", opts.device);
  }
  return args;
}

export async function startEmbeddingDaemon(
  opts: EmbeddingDaemonStartOptions,
): Promise<{ pid: number }> {
  const pidPath = resolveEmbeddingPidFilePath(opts.dataDir);
  const existing = readRunningPid(opts.dataDir, "embedding");
  if (existing !== null) {
    throw new Error(`embedding daemon already running at pid ${existing}`);
  }

  const { binaryName } = resolvePlatformAsset();
  const binPath = resolveServerBinPath(opts.dataDir, binaryName);
  if (!existsSync(binPath)) {
    throw new Error(
      "backend not downloaded; run 'atomic-agent models update'",
    );
  }

  const model = getEmbeddingModelDef(opts.modelId);
  const modelPath = resolveModelFilePath(opts.dataDir, model.id, model.filename);
  if (!existsSync(modelPath)) {
    throw new Error(
      `embedding model ${opts.modelId} not downloaded; run 'atomic-agent models pull-embedding ${opts.modelId}'`,
    );
  }

  const device = await resolveManagedDevice(binPath, opts.device);
  const args = buildEmbeddingServerArgs({ ...opts, device }, modelPath);

  const logFd = openSync(resolveEmbeddingLogFilePath(opts.dataDir), "a");
  try {
    const child = spawn(binPath, args, {
      stdio: ["ignore", logFd, logFd],
      detached: true,
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
      env: { ...process.env },
    });
    child.unref();
    if (child.pid == null) {
      throw new Error("spawn failed: no pid");
    }
    writeFileSync(pidPath, String(child.pid), "utf-8");
    await waitForEmbeddingHealthOkWithLog(opts.dataDir, opts.port, 30_000);
    return { pid: child.pid };
  } finally {
    closeSync(logFd);
  }
}

async function waitForEmbeddingHealthOkWithLog(
  dataDir: string,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await probeLlamaHealth(port);
    if (r === "ok") return;
    await new Promise((r2) => setTimeout(r2, 500));
  }
  let tail = "";
  try {
    const logPath = resolveEmbeddingLogFilePath(dataDir);
    const buf = readFileSync(logPath, "utf-8");
    tail = buf.length > 4096 ? buf.slice(-4096) : buf;
  } catch {
    tail = "(no log)";
  }
  throw new Error(
    `embedding llama-server did not become healthy within ${timeoutMs}ms. Log tail:\n${tail}`,
  );
}

export async function stopEmbeddingDaemon(
  dataDir: string,
  opts?: { timeoutMs?: number },
): Promise<void> {
  const pidPath = resolveEmbeddingPidFilePath(dataDir);
  let raw: string;
  try {
    raw = readFileSync(pidPath, "utf-8").trim();
  } catch {
    return;
  }
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0) {
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
    return;
  }

  const liveness = classifyPidLiveness(pid);
  if (liveness === "dead") {
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
    return;
  }
  if (liveness === "foreign") {
    throw new ForeignDaemonError(pid);
  }

  const timeoutMs = opts?.timeoutMs ?? 3000;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { timeout: 5000, stdio: "ignore" });
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }

  try {
    unlinkSync(pidPath);
  } catch {
    /* ignore */
  }
}

export async function getEmbeddingDaemonStatus(
  dataDir: string,
  port: number,
): Promise<DaemonStatus> {
  const pid = readRunningPid(dataDir, "embedding");
  const h = await probeLlamaHealth(port);
  return {
    running: pid !== null,
    pid,
    port,
    healthy: h === "ok",
    loading: h === "loading",
  };
}

/**
 * Memory-v2 phase 1B. Orchestrated start for both daemons.
 *
 * Atomicity contract (user requirement):
 *   - Chat daemon is the **primary**. If it fails to start, the
 *     embedding daemon is **not** attempted and the function rejects.
 *   - Embedding daemon is the **optional secondary**. If it fails to
 *     start (e.g. model missing on disk, port collision), the chat
 *     daemon stays up and the function returns
 *     `{ chat: { pid }, embedding: { error } }` so the CLI can warn
 *     the operator. The runtime then falls back to FTS5-only recall
 *     for the duration of the session.
 *   - If `embedding` options are omitted, only the chat daemon is
 *     started — observably identical to the legacy `startDaemon`
 *     code path.
 *
 * Lifecycle pairing: `stopBoth` always tries to kill both pid files,
 * regardless of which one is actually alive, so a half-broken state
 * is recoverable with a single `atomic-agent models stop`.
 */
export interface StartBothResult {
  chat: { pid: number };
  embedding:
    | { pid: number }
    | { error: string }
    | { skipped: true };
}

export async function startChatAndEmbeddingDaemons(opts: {
  chat: DaemonStartOptions;
  embedding?: EmbeddingDaemonStartOptions;
}): Promise<StartBothResult> {
  const chatResult = await startDaemon(opts.chat);
  if (!opts.embedding) {
    return {
      chat: chatResult,
      embedding: { skipped: true },
    };
  }
  try {
    const embResult = await startEmbeddingDaemon(opts.embedding);
    return {
      chat: chatResult,
      embedding: embResult,
    };
  } catch (e) {
    return {
      chat: chatResult,
      embedding: { error: e instanceof Error ? e.message : String(e) },
    };
  }
}

/**
 * Stop both daemons. Always tries the embedding pid file first so a
 * fast `models stop && models start` cycle doesn't leave the
 * embedding pid stale.
 */
export async function stopChatAndEmbeddingDaemons(
  dataDir: string,
  opts?: { timeoutMs?: number },
): Promise<void> {
  // Stop both sides independently: a failure on one (e.g. a foreign,
  // cross-user daemon raising `ForeignDaemonError`) must not prevent the
  // other from being stopped. Collected errors are re-thrown afterwards so
  // callers still learn that the stop was not fully successful.
  const errors: unknown[] = [];
  try {
    await stopEmbeddingDaemon(dataDir, opts);
  } catch (e) {
    errors.push(e);
  }
  try {
    await stopDaemon(dataDir, opts);
  } catch (e) {
    errors.push(e);
  }
  if (errors.length > 0) {
    throw new Error(
      errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; "),
    );
  }
}
