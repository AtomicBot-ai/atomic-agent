import { execSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { resolveLogFilePath, resolveModelFilePath, resolvePidFilePath, resolveServerBinPath } from "./backend-paths.js";
import { getLocalModelDef, type LocalModelId } from "./models-catalog.js";
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
    "-1",
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

export function readRunningPid(dataDir: string): number | null {
  const pidPath = resolvePidFilePath(dataDir);
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
  try {
    process.kill(pid, 0);
  } catch {
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
    return null;
  }
  return pid;
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
  throw new Error(
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

  const args = buildLlamaServerArgs(opts, modelPath, model.id);

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

  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    /* dead */
  }
  if (!alive) {
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
    return;
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
