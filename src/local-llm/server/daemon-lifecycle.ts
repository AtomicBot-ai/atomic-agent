import { getConfig } from "../../config/index.js";
import type { LocalLegRole } from "./worker-slots.js";
import { resolveConfiguredSlots } from "./worker-slots.js";
import { execSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { totalmem } from "node:os";

import { readBackendVersion } from "../backend/backend-version.js";
import {
  resolveEmbeddingLogFilePath,
  resolveEmbeddingPidFilePath,
  resolveLogFilePath,
  resolveModelFilePath,
  resolvePidFilePath,
  resolveServerBinPath,
  resolveLaunchFilePath,
  resolveThroughputFilePath,
} from "../backend-paths.js";
import {
  buildKvLayout,
  estimateContextSize,
  estimateLaunchKvBytes,
  MANAGED_KV_CACHE_TYPE,
  resolveDeviceFreeVramMiB,
  resolveKvBudgetMiB,
  resolveUnifiedMemoryHeadroomMiB,
  UNIFIED_MEMORY_KV_SHARE,
  type KvLayoutSource,
} from "./context-size.js";
import {
  classifyPrefixReuse,
  kvLayoutSourceFromMetadata,
  readGgufMetadataSync,
  type GgufMetadata,
} from "../catalog/gguf-metadata.js";
import {
  deviceTableOnce,
  resolveManagedDevice,
  sharesSystemMemory,
  type ListDevices,
} from "../backend/gpu-devices.js";
import {
  resolveSwaFullDecision,
  type SwaFullDecision,
  type SwaFullPreference,
} from "./swa-full.js";
import {
  getEmbeddingModelDef,
  getLocalModelDef,
  type EmbeddingModelId,
  type LocalModelId,
} from "../catalog/models-catalog.js";
import { resolvePlatformAsset } from "../backend/platform-assets.js";
import { assertPortFree, waitForOwnDaemon } from "./daemon-launch-guard.js";
import {
  buildDaemonEnv,
  resolveManagedServerApiKey,
} from "./managed-api-key.js";

export interface DaemonStartOptions {
  /** Interactive callers allow cold GPU compilation while keeping selection available. */
  healthTimeoutMs?: number;
  /** Cancel an owned launch while its model is loading. */
  signal?: AbortSignal;
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
   * The launch's `--list-devices` table (`deviceTableOnce`) when the
   * caller already asked it to pick `device`: the context fit reads the
   * free memory from the same answer instead of starting the backend a
   * second time. Absent: `startDaemon` enumerates, at most once.
   */
  listDevices?: ListDevices;
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
  /**
   * Request slots (`localModels.managed.parallel`): a pinned number, or
   * `"auto"` to derive it from the context this launch actually gets
   * (see `worker-slots.ts`). Undefined keeps the historical
   * `--parallel 2` so an embedder's launch stays byte-identical.
   */
  parallel?: number | "auto";
  /**
   * What the local leg does in the run mode this launch belongs to —
   * serve fusion's workers, or run the single orchestrating stream while
   * the workers are in the cloud (see `worker-slots.ts`). Only `"auto"`
   * slots read it; a pinned `parallel` still wins. Resolved by the
   * caller, per launch, because the run mode lives a layer above this
   * one (`src/llm/**` imports `src/local-llm/**`, never the reverse) and
   * because an operator can switch direction between a stop and a start.
   * Undefined means `"workers"`, the historical behaviour.
   */
  localLegRole?: LocalLegRole;
  /**
   * `localModels.completionMaxTokens` — the reply part of the worker
   * footprint `"auto"` slots are counted in (see `worker-slots.ts`).
   * `startDaemon` reads it from config when omitted, so the slot count a
   * daemon launches with is the one the `### fusion` prompt block states.
   */
  completionMaxTokens?: number;
  /**
   * `localModels.managed.swaFull`: whether a sliding-window model gets
   * `--swa-full` (see `swa-full.ts`). Undefined keeps the flag off, so a
   * launch that passes nothing stays byte-identical.
   */
  swaFull?: SwaFullPreference;
  /**
   * Resolved by `startDaemon` from the model header and the memory
   * budget; a caller passing it directly forces the flag. Internal —
   * `buildLlamaServerArgs` appends `--swa-full` when `true`.
   */
  swaFullFlag?: boolean;
  /**
   * Run the throughput probe once the server is healthy (default
   * `true`): one 64-token completion whose `timings.predicted_per_second`
   * is written next to the pid file and shown to the fusion orchestrator
   * as "~N tok/s single stream". Costs a few seconds of readiness — a
   * 31B model at 3 tok/s spends ~20 s on it, a 4B one 3-5 s on a 16 GB
   * Mac — so a speed an earlier start measured on the same launch (model,
   * build, device, context, whole fit) in the last day is carried over
   * instead (`readReusableThroughput`). `false` skips both and leaves the
   * speed unknown.
   */
  throughputProbe?: boolean;
  /**
   * The key the server requires (issue #582), handed to the child as
   * `LLAMA_API_KEY` — never argv. `startDaemon` resolves it from
   * `localModels.apiKey`, falling back to the key persisted in `dataDir`,
   * so a caller passes it only to force one.
   */
  apiKey?: string;
}

/** What `probeThroughput` measured on one short completion. */
export interface ThroughputSample {
  /** `timings.predicted_per_second` — single-stream decode speed. */
  tokensPerSecond: number;
  /** Tokens the probe generated (`timings.predicted_n`). */
  predictedTokens: number;
  /** Prompt-evaluation speed, when the server reported it. */
  promptTokensPerSecond: number | null;
}

/** The record `startDaemon` leaves at `resolveThroughputFilePath`. */
export interface ThroughputRecord extends ThroughputSample {
  /** Pid of the daemon instance the sample belongs to. */
  pid: number;
  modelId: string;
  /** Epoch ms of the measurement (kept when a later start carries it over). */
  measuredAt: number;
  /**
   * What the speed was measured on (`throughputBasis`: model, llama.cpp
   * build and install, device, context, whether the model fit the device
   * whole). Absent on records written before speeds were carried over;
   * those are never reused.
   */
  measuredOn?: string;
  /**
   * Whether the probe had the server to itself: it ran on the only slot,
   * or no slot was busy as it began and as it ended (`slotsAllIdle`). Only
   * such a figure is carried over. On eight slots, requests that came in
   * during the probe decoded beside it and it measured 1.1 tok/s, against
   * 13-22 alone, for the same model on the same Mac.
   */
  alone?: boolean;
}

/**
 * How long a measured speed is carried over to later starts of the same
 * launch before it is measured again. Speed is a property of the model,
 * the machine and how the model sits on it, not of one server process;
 * re-measuring it on every start kept the model from answering for
 * another 3-5 s after it had loaded, on every switch back to the local
 * model. A day, so a figure taken on a bad afternoon (thermal limits,
 * another app on the GPU) does not outlive it by much.
 */
export const THROUGHPUT_REUSE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * What a speed measurement describes: the model, the llama.cpp build on
 * disk (its tag and when it was installed, so an update or a reinstall
 * measures again), the device, the launch's context, and whether the
 * weights and that context's cache fit the device whole (`fitsDevice`) —
 * when they do not, llama.cpp's `-fit` leaves layers on the CPU and the
 * model decodes at another speed; `null` when there was no free figure
 * to tell.
 */
export function throughputBasis(
  dataDir: string,
  modelId: string,
  device: string | undefined,
  launch: { contextSize: number; fitsDevice: boolean | null },
): string {
  const backend = readBackendVersion(dataDir);
  return JSON.stringify([
    modelId,
    backend?.tag ?? null,
    backend?.downloadedAt ?? null,
    device ?? null,
    launch.contextSize,
    launch.fitsDevice,
  ]);
}

/** Tokens the probe asks for: enough to average out the first-token cost. */
export const THROUGHPUT_PROBE_TOKENS = 64;

/** A prompt long enough to decode from, short enough to evaluate in ms. */
const THROUGHPUT_PROBE_PROMPT =
  "Count upward from one, one number per line, and keep going:\n1\n2\n3\n";

export interface ProbeThroughputOptions {
  port: number;
  host?: string;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  /** Whole-probe deadline. Default 120 s — 64 tokens at 0.6 tok/s. */
  timeoutMs?: number;
  nPredict?: number;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One short greedy completion against a healthy server, read for the
 * decode speed llama-server itself reports. Sent with `id_slot: -1` and
 * `cache_prompt: false`, so it neither pins nor pollutes a slot a session
 * will later be given. Never throws: a server that refuses or times out
 * simply leaves the speed unknown.
 */
export async function probeThroughput(
  opts: ProbeThroughputOptions,
): Promise<ThroughputSample | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `http://${opts.host ?? "127.0.0.1"}:${opts.port}/completion`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: THROUGHPUT_PROBE_PROMPT,
        n_predict: opts.nPredict ?? THROUGHPUT_PROBE_TOKENS,
        temperature: 0,
        stream: false,
        cache_prompt: false,
        id_slot: -1,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const timings = (body.timings ?? {}) as Record<string, unknown>;
    const tokensPerSecond = toFiniteNumber(timings.predicted_per_second);
    const predictedTokens =
      toFiniteNumber(timings.predicted_n) ??
      toFiniteNumber(body.tokens_predicted) ??
      0;
    if (tokensPerSecond === null || tokensPerSecond <= 0 || predictedTokens <= 0) {
      return null;
    }
    return {
      tokensPerSecond,
      predictedTokens,
      promptTokensPerSecond: toFiniteNumber(timings.prompt_per_second),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The launch decisions of the running chat daemon, next to its pid file.
 * A runtime that did not start the daemon (the TUI after `models start`)
 * reads `swaFull` from here to know whether the model's cache is
 * partially reusable.
 */
export interface LaunchRecord {
  pid: number;
  modelId: string;
  contextSize: number;
  swaFull: boolean;
  prefixReuse: "partial" | "none" | null;
  launchedAt: number;
}

export function writeLaunchRecord(dataDir: string, record: LaunchRecord): void {
  try {
    writeFileSync(resolveLaunchFilePath(dataDir), JSON.stringify(record), "utf-8");
  } catch {
    // Best-effort, like the throughput record.
  }
}

/** The launch record for the live daemon, or `null` (none, unreadable, other pid). */
export function readLaunchRecord(
  dataDir: string,
  livePid: number | null,
): LaunchRecord | null {
  if (livePid === null) return null;
  try {
    const parsed = JSON.parse(
      readFileSync(resolveLaunchFilePath(dataDir), "utf-8"),
    ) as Partial<LaunchRecord>;
    if (parsed.pid !== livePid || typeof parsed.modelId !== "string") return null;
    return {
      pid: livePid,
      modelId: parsed.modelId,
      contextSize: toFiniteNumber(parsed.contextSize) ?? 0,
      swaFull: parsed.swaFull === true,
      prefixReuse:
        parsed.prefixReuse === "partial" || parsed.prefixReuse === "none"
          ? parsed.prefixReuse
          : null,
      launchedAt: toFiniteNumber(parsed.launchedAt) ?? 0,
    };
  } catch {
    return null;
  }
}

export function writeThroughputRecord(
  dataDir: string,
  record: ThroughputRecord,
): void {
  try {
    writeFileSync(
      resolveThroughputFilePath(dataDir),
      JSON.stringify(record),
      "utf-8",
    );
  } catch {
    // Best-effort: a record that cannot be written leaves the speed
    // unknown, which is where it was.
  }
}

/**
 * The throughput measured for the daemon instance now running — `null`
 * when nothing was recorded, the record is unreadable, or it belongs to
 * another pid (a previous daemon, possibly another model). Pass the pid
 * from `readRunningPid` so a stale record never describes a live server.
 */
export function readThroughputRecord(
  dataDir: string,
  livePid: number | null,
): ThroughputRecord | null {
  if (livePid === null) return null;
  let raw: string;
  try {
    raw = readFileSync(resolveThroughputFilePath(dataDir), "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ThroughputRecord>;
    const tokensPerSecond = toFiniteNumber(parsed.tokensPerSecond);
    if (
      parsed.pid !== livePid ||
      tokensPerSecond === null ||
      tokensPerSecond <= 0 ||
      typeof parsed.modelId !== "string"
    ) {
      return null;
    }
    return {
      pid: livePid,
      modelId: parsed.modelId,
      tokensPerSecond,
      predictedTokens: toFiniteNumber(parsed.predictedTokens) ?? 0,
      promptTokensPerSecond: toFiniteNumber(parsed.promptTokensPerSecond),
      measuredAt: toFiniteNumber(parsed.measuredAt) ?? 0,
      ...(typeof parsed.measuredOn === "string" ? { measuredOn: parsed.measuredOn } : {}),
      ...(typeof parsed.alone === "boolean" ? { alone: parsed.alone } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The speed an earlier start measured on this same `basis`
 * (`throughputBasis`), whichever daemon it was stamped for — `null` when
 * there is none, it describes another model, build or device, the probe
 * did not have the server to itself (`alone`), or it is older than
 * `THROUGHPUT_REUSE_MAX_AGE_MS`. Read before a launch clears the record.
 */
export function readReusableThroughput(
  dataDir: string,
  basis: string,
  now: number = Date.now(),
): ThroughputRecord | null {
  let parsed: Partial<ThroughputRecord>;
  try {
    parsed = JSON.parse(
      readFileSync(resolveThroughputFilePath(dataDir), "utf-8"),
    ) as Partial<ThroughputRecord>;
  } catch {
    return null;
  }
  const tokensPerSecond = toFiniteNumber(parsed.tokensPerSecond);
  const measuredAt = toFiniteNumber(parsed.measuredAt);
  if (
    parsed.measuredOn !== basis ||
    parsed.alone !== true ||
    typeof parsed.modelId !== "string" ||
    typeof parsed.pid !== "number" ||
    tokensPerSecond === null ||
    tokensPerSecond <= 0 ||
    measuredAt === null ||
    now < measuredAt ||
    now - measuredAt > THROUGHPUT_REUSE_MAX_AGE_MS
  ) {
    return null;
  }
  return {
    pid: parsed.pid,
    modelId: parsed.modelId,
    tokensPerSecond,
    predictedTokens: toFiniteNumber(parsed.predictedTokens) ?? 0,
    promptTokensPerSecond: toFiniteNumber(parsed.promptTokensPerSecond),
    measuredAt,
    measuredOn: basis,
    alone: true,
  };
}

/**
 * Whether no slot of the server on `port` is busy: `GET /slots` answered
 * in time and every slot says `is_processing: false`. A busy slot, a
 * `/slots` that does not answer in time (it hangs while a slot evaluates
 * a long prompt), a refusal, or a build without the endpoint all answer
 * `false`. Never throws.
 */
export async function slotsAllIdle(opts: {
  port: number;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<boolean> {
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    const res = await (opts.fetchImpl ?? fetch)(
      `http://127.0.0.1:${opts.port}/slots`,
      { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 1_500) },
    );
    if (!res.ok) return false;
    const slots = (await res.json()) as unknown;
    return (
      Array.isArray(slots) &&
      slots.length > 0 &&
      slots.every(
        (slot) =>
          typeof slot === "object" &&
          slot !== null &&
          (slot as { is_processing?: unknown }).is_processing === false,
      )
    );
  } catch {
    return false;
  }
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
    // Resolved here rather than at the call sites because this is where
    // the *effective* context is known — the number of slots is how many
    // usable shares that context divides into, and the callers pass the
    // configured `0` (auto-size) straight through.
    String(
      opts.parallel === undefined
        ? 2
        : resolveConfiguredSlots(opts.parallel, {
            contextSize:
              effectiveContextSize && effectiveContextSize > 0
                ? effectiveContextSize
                : null,
            cpuOnly: opts.device === "cpu",
            ...(opts.completionMaxTokens === undefined
              ? {}
              : { completionMaxTokens: opts.completionMaxTokens }),
            ...(opts.localLegRole === undefined
              ? {}
              : { localLegRole: opts.localLegRole }),
          }),
    ),
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
  if (
    opts.device !== "cpu" &&
    opts.tensorSplit &&
    opts.tensorSplit.length > 0
  ) {
    args.push(
      "--split-mode",
      "layer",
      "--tensor-split",
      opts.tensorSplit.join(","),
    );
  }
  if (opts.chatTemplateFile) {
    args.push("--chat-template-file", opts.chatTemplateFile);
  }
  if (opts.swaFullFlag === true) {
    args.push("--swa-full");
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
 * device it reads the target device's free VRAM from the launch's
 * `--list-devices` table, and on a device that shares the system's RAM
 * (Apple silicon, an integrated GPU) the machine's physical memory too.
 * Best-effort — any enumeration failure degrades to the no-VRAM default.
 * Skips the probe entirely when the operator pinned a value or offload
 * is CPU-only.
 *
 * - `kvBudgetBytes`: what the cache may take, within the system's
 *   headroom on unified memory — the budget `--swa-full` is weighed
 *   against (not the context's 1/16 share).
 * - `deviceBudgetBytes`: what is left of the device's own free figure
 *   after weights, projector and compute buffers (negative when the
 *   weights alone overflow it), against which a launch's cache says
 *   whether the model fits the device whole.
 * - `note`: why a unified-memory machine got less than its free figure
 *   would fit, for the daemon log.
 */
async function resolveEffectiveContextSize(
  device: string | undefined,
  model: {
    fileSizeGb: number;
    maxContextLength: number;
    mmprojFileSizeGb?: number;
  },
  opts: {
    configured: number;
    hasMmproj: boolean;
    /** The model's attention layout from its header, when readable. */
    kvLayout?: KvLayoutSource | null;
    listDevices: ListDevices;
  },
): Promise<{
  contextSize: number;
  kvBudgetBytes: number | null;
  deviceBudgetBytes: number | null;
  note: string | null;
}> {
  let freeVramMiB: number | null = null;
  let systemMemoryMiB: number | null = null;
  if (opts.configured <= 0 && device && device !== "cpu") {
    const devices = await opts.listDevices();
    freeVramMiB = resolveDeviceFreeVramMiB(devices, device);
    const target = devices.find((d) => d.id === device);
    if (freeVramMiB !== null && target && sharesSystemMemory(target)) {
      systemMemoryMiB = totalmem() / (1024 * 1024);
    }
  }
  const mmprojSizeGb = opts.hasMmproj ? (model.mmprojFileSizeGb ?? 0) : 0;
  const input = {
    freeVramMiB,
    modelSizeGb: model.fileSizeGb,
    mmprojSizeGb,
    maxContextLength: model.maxContextLength,
    configuredContextSize: opts.configured,
    kvLayout: opts.kvLayout ? buildKvLayout(opts.kvLayout) : null,
    cacheType: MANAGED_KV_CACHE_TYPE,
  };
  const contextSize = estimateContextSize({ ...input, systemMemoryMiB });
  let note: string | null = null;
  if (systemMemoryMiB !== null) {
    const fits = estimateContextSize(input);
    if (fits > contextSize) {
      note =
        `held to ${Math.round(systemMemoryMiB / 1024)} GB of unified memory: ` +
        `at most 1/${Math.round(1 / UNIFIED_MEMORY_KV_SHARE)} of it for the KV cache, ` +
        `${Math.round(resolveUnifiedMemoryHeadroomMiB(systemMemoryMiB) / 1024)} GB left to the system ` +
        `(${fits} would fit the GPU's free figure)`;
    }
  }
  const budgetBytes = (withSystemMemory: boolean): number | null =>
    freeVramMiB !== null && freeVramMiB > 0
      ? resolveKvBudgetMiB({
          freeVramMiB,
          modelSizeGb: model.fileSizeGb,
          mmprojSizeGb,
          systemMemoryMiB: withSystemMemory ? systemMemoryMiB : null,
        }) *
        1024 *
        1024
      : null;
  const kvBudgetBytes = budgetBytes(true);
  return {
    contextSize,
    kvBudgetBytes: kvBudgetBytes === null ? null : Math.max(0, kvBudgetBytes),
    deviceBudgetBytes: budgetBytes(false),
    note,
  };
}

/**
 * The model's header, read before launch. Best-effort: a file that is
 * not GGUF, or one whose header cannot be read, leaves the layout unknown
 * and the launch on the file-size fallback — never a failed start.
 * Synchronous on purpose: the health wait that follows is timer-driven,
 * and a start must reach it without yielding to real I/O in between.
 */
function readModelHeader(modelPath: string): GgufMetadata | null {
  try {
    return readGgufMetadataSync(modelPath);
  } catch {
    return null;
  }
}

/**
 * `localModels.completionMaxTokens` for a launch whose caller passed
 * none. Best-effort: a config that cannot be read leaves the slot math on
 * its default reply allowance rather than failing the launch.
 */
function readConfiguredCompletionMaxTokens(): number | undefined {
  try {
    return getConfig().localModels.completionMaxTokens;
  } catch {
    return undefined;
  }
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
    const body = (await res.json().catch(() => null)) as {
      status?: string;
    } | null;
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
    return (err as NodeJS.ErrnoException | null)?.code === "EPERM"
      ? "foreign"
      : "dead";
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

export interface DaemonStartResult {
  pid: number;
  /**
   * Single-stream decode speed from the start-time probe, or `null` when
   * the probe was skipped or did not answer. Also written next to the
   * pid file (`readThroughputRecord`) for a runtime that connects later.
   */
  tokensPerSecond: number | null;
  /** The `--ctx-size` the daemon launched with (`0`: left to llama.cpp). */
  contextSize: number;
  /** The `--swa-full` decision and its reason (also in the daemon log). */
  swaFull: SwaFullDecision;
  /** Whether the model's prompt cache is reusable partially or only whole. */
  prefixReuse: "partial" | "none" | null;
}

export async function startDaemon(
  opts: DaemonStartOptions,
): Promise<DaemonStartResult> {
  const pidPath = resolvePidFilePath(opts.dataDir);
  const existing = readRunningPid(opts.dataDir);
  if (existing !== null) {
    throw new Error(`already running at pid ${existing}`);
  }
  await assertPortFree(opts.port);

  const { binaryName } = resolvePlatformAsset();
  const binPath = resolveServerBinPath(opts.dataDir, binaryName);
  if (!existsSync(binPath)) {
    throw new Error("backend not downloaded; run 'atomic-agent models update'");
  }

  const model = getLocalModelDef(opts.modelId);
  const modelPath = resolveModelFilePath(
    opts.dataDir,
    model.id,
    model.filename,
  );
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
  // One `--list-devices` for the whole launch: the device pick and the
  // context fit below read the same table (`deviceTableOnce`).
  const listDevices = opts.listDevices ?? deviceTableOnce(binPath);
  const device = await resolveManagedDevice(binPath, opts.device, {
    multiGpu: (opts.tensorSplit?.length ?? 0) > 0,
    listDevices,
  });
  // The header says what the KV cache really costs and whether the
  // model's cache can be reused partially — both decide flags below.
  const header = readModelHeader(modelPath);
  const kvLayout = header ? kvLayoutSourceFromMetadata(header) : null;
  const prefixReuse = header ? classifyPrefixReuse(header) : null;
  const {
    contextSize,
    kvBudgetBytes,
    deviceBudgetBytes,
    note: contextNote,
  } = await resolveEffectiveContextSize(device, model, {
    configured: opts.contextSize ?? 0,
    hasMmproj: Boolean(opts.mmprojFile),
    kvLayout,
    listDevices,
  });
  const swaFull =
    opts.swaFullFlag !== undefined
      ? {
          enabled: opts.swaFullFlag,
          reason: `swa-full: ${opts.swaFullFlag ? "on" : "off"} (forced by caller)`,
          estimate: null,
          slidingLayers: prefixReuse?.slidingWindowLayers ?? 0,
        }
      : resolveSwaFullDecision({
          preference: opts.swaFull ?? "auto",
          layout: kvLayout,
          contextSize,
          kvBudgetBytes,
          cacheType: MANAGED_KV_CACHE_TYPE,
        });
  // `--swa-full` makes the sliding layers' cache whole-context, so the
  // prefix becomes partially reusable again; a hybrid stays reusable
  // only whole either way.
  const effectivePrefixReuse: "partial" | "none" | null =
    prefixReuse === null
      ? null
      : swaFull.enabled && !prefixReuse.hybrid
        ? "partial"
        : prefixReuse.prefixReuse;
  // Whether the weights and this context's cache fit the device whole, or
  // llama.cpp's `-fit` will leave layers on the CPU — another speed.
  // Unknown (`null`) with no free figure to weigh them against.
  const fitsDevice =
    deviceBudgetBytes === null
      ? null
      : estimateLaunchKvBytes({
          kvLayout: kvLayout ? buildKvLayout(kvLayout) : null,
          modelSizeGb: model.fileSizeGb,
          contextSize,
          swaFull: swaFull.enabled,
        }) <= deviceBudgetBytes;
  // The speed an earlier start measured on this same launch, read before
  // this one clears the record: carried over, it spares the probe
  // (`readReusableThroughput`).
  const speedBasis = throughputBasis(opts.dataDir, model.id, device, {
    contextSize,
    fitsDevice,
  });
  const knownSpeed =
    opts.throughputProbe === false
      ? null
      : readReusableThroughput(opts.dataDir, speedBasis);
  const completionMaxTokens =
    opts.completionMaxTokens ?? readConfiguredCompletionMaxTokens();
  const apiKey =
    opts.apiKey ??
    resolveManagedServerApiKey(opts.dataDir, readConfiguredApiKey());
  const args = buildLlamaServerArgs(
    {
      ...opts,
      device,
      swaFullFlag: swaFull.enabled,
      ...(completionMaxTokens === undefined ? {} : { completionMaxTokens }),
    },
    modelPath,
    model.id,
    contextSize,
  );

  const logFd = openSync(resolveLogFilePath(opts.dataDir), "a");
  try {
    // The launch decisions, in the daemon's own log where a reader
    // looking at the flags will look for them.
    const reuseWhy =
      prefixReuse && prefixReuse.reasons.length > 0
        ? ` — ${prefixReuse.reasons.join("; ")}` +
          (effectivePrefixReuse === "partial" && prefixReuse.prefixReuse === "none"
            ? " (--swa-full restores partial reuse)"
            : "")
        : "";
    writeSync(
      logFd,
      [
        `[atomic-agent] launch: model ${model.id}` +
          (header
            ? ` (${header.architecture}, ${header.blockCount ?? "?"} layers, trained context ${header.contextLength ?? "?"})`
            : " (header unreadable)"),
        `[atomic-agent] launch: --ctx-size ${contextSize || "(llama.cpp default)"}` +
          (kvLayout ? " fitted from the model's KV layout" : " fitted from the file-size fallback") +
          (contextNote ? `, ${contextNote}` : ""),
        `[atomic-agent] launch: ${swaFull.reason}`,
        `[atomic-agent] launch: prefix reuse ${effectivePrefixReuse ?? "unknown"}${reuseWhy}`,
        "",
      ].join("\n"),
    );
    opts.signal?.throwIfAborted();
    const child = spawn(binPath, args, {
      stdio: ["ignore", logFd, logFd],
      detached: true,
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
      env: buildDaemonEnv(apiKey),
    });
    // A spawn that fails (EACCES, ENOENT) still emits `error` on a later tick;
    // unheard, that is an uncaught exception that takes the agent down instead
    // of the "spawn failed" below, which the caller reports in words.
    child.once("error", () => {});
    child.unref();
    if (child.pid == null) {
      throw new Error("spawn failed: no pid");
    }
    writeFileSync(pidPath, String(child.pid), "utf-8");
    try {
      await waitForOwnDaemon({
        signal: opts.signal,
        child,
        port: opts.port,
        alias: model.id,
        timeoutMs: opts.healthTimeoutMs ?? 30_000,
        label: "llama-server",
        probeHealth: probeLlamaHealth,
        readLog: () => readFileSync(resolveLogFilePath(opts.dataDir), "utf-8"),
        makeHealthError: (m) => new DaemonHealthError(m),
      });
    } catch (err) {
      abandonChild(child.pid, pidPath);
      throw err;
    }
    // A stale record must never outlive the daemon it described: drop
    // it before the probe so a skipped or failed probe leaves nothing
    // behind that `readThroughputRecord` could mistake (it also checks
    // the pid, but the file is cheap to clear). A speed carried over was
    // read above, and is stamped for this daemon instead of measured.
    try {
      unlinkSync(resolveThroughputFilePath(opts.dataDir));
    } catch {
      /* none recorded */
    }
    let tokensPerSecond: number | null = null;
    if (knownSpeed) {
      tokensPerSecond = knownSpeed.tokensPerSecond;
      writeThroughputRecord(opts.dataDir, { ...knownSpeed, pid: child.pid });
    } else if (opts.throughputProbe !== false) {
      // On the only slot nothing can decode beside the probe. With more, a
      // turn already running when it starts, or still running when it
      // ends, shared the GPU with it: such a figure is not carried over.
      const oneSlot = args[args.indexOf("--parallel") + 1] === "1";
      const idleBefore =
        oneSlot || (await slotsAllIdle({ port: opts.port, apiKey }));
      const sample = await probeThroughput({
        port: opts.port,
        apiKey,
      });
      if (sample) {
        tokensPerSecond = sample.tokensPerSecond;
        const alone =
          oneSlot ||
          (idleBefore && (await slotsAllIdle({ port: opts.port, apiKey })));
        writeThroughputRecord(opts.dataDir, {
          ...sample,
          pid: child.pid,
          modelId: model.id,
          measuredAt: Date.now(),
          measuredOn: speedBasis,
          alone,
        });
      }
    }
    writeLaunchRecord(opts.dataDir, {
      pid: child.pid,
      modelId: model.id,
      contextSize,
      swaFull: swaFull.enabled,
      prefixReuse: effectivePrefixReuse,
      launchedAt: Date.now(),
    });
    return {
      pid: child.pid,
      tokensPerSecond,
      contextSize,
      swaFull,
      prefixReuse: effectivePrefixReuse,
    };
  } finally {
    closeSync(logFd);
  }
}

/**
 * `localModels.apiKey` — the key the agent's clients send. A config that
 * cannot be read yields none, and the launch falls back to the key
 * persisted in the data dir.
 */
function readConfiguredApiKey(): string | null {
  try {
    return getConfig().localModels.apiKey ?? null;
  } catch {
    return null;
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
      execSync(`taskkill /PID ${pid} /T /F`, {
        timeout: 5000,
        stdio: "ignore",
      });
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

export async function getDaemonStatus(
  dataDir: string,
  port: number,
): Promise<DaemonStatus> {
  const pid = readRunningPid(dataDir);
  const h = await probeLlamaHealth(port);
  return {
    running: pid !== null,
    pid,
    port,
    // Health on the port is ours only while our pid is alive: another
    // server answering there is not this daemon being up.
    healthy: pid !== null && h === "ok",
    loading: pid !== null && h === "loading",
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
// genuinely common helpers (`waitForOwnDaemon`, `probeLlamaHealth`).
// ---------------------------------------------------------------------

export interface EmbeddingDaemonStartOptions {
  signal?: AbortSignal;
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
  /** Same as `DaemonStartOptions.apiKey`; both daemons share one key. */
  apiKey?: string;
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
  await assertPortFree(opts.port);

  const { binaryName } = resolvePlatformAsset();
  const binPath = resolveServerBinPath(opts.dataDir, binaryName);
  if (!existsSync(binPath)) {
    throw new Error("backend not downloaded; run 'atomic-agent models update'");
  }

  const model = getEmbeddingModelDef(opts.modelId);
  const modelPath = resolveModelFilePath(
    opts.dataDir,
    model.id,
    model.filename,
  );
  if (!existsSync(modelPath)) {
    throw new Error(
      `embedding model ${opts.modelId} not downloaded; run 'atomic-agent models pull-embedding ${opts.modelId}'`,
    );
  }

  const device = await resolveManagedDevice(binPath, opts.device);
  const apiKey =
    opts.apiKey ??
    resolveManagedServerApiKey(opts.dataDir, readConfiguredApiKey());
  const args = buildEmbeddingServerArgs({ ...opts, device }, modelPath);

  const logFd = openSync(resolveEmbeddingLogFilePath(opts.dataDir), "a");
  try {
    opts.signal?.throwIfAborted();
    const child = spawn(binPath, args, {
      stdio: ["ignore", logFd, logFd],
      detached: true,
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
      env: buildDaemonEnv(apiKey),
    });
    // A spawn that fails (EACCES, ENOENT) still emits `error` on a later tick;
    // unheard, that is an uncaught exception that takes the agent down instead
    // of the "spawn failed" below, which the caller reports in words.
    child.once("error", () => {});
    child.unref();
    if (child.pid == null) {
      throw new Error("spawn failed: no pid");
    }
    writeFileSync(pidPath, String(child.pid), "utf-8");
    try {
      await waitForOwnDaemon({
        signal: opts.signal,
        child,
        port: opts.port,
        alias: model.id,
        timeoutMs: 30_000,
        label: "embedding llama-server",
        probeHealth: probeLlamaHealth,
        readLog: () =>
          readFileSync(resolveEmbeddingLogFilePath(opts.dataDir), "utf-8"),
        makeHealthError: (m) => new Error(m),
      });
    } catch (err) {
      abandonChild(child.pid, pidPath);
      throw err;
    }
    return { pid: child.pid };
  } finally {
    closeSync(logFd);
  }
}

/**
 * A launch that failed after the spawn must not leave its child behind
 * or a pid file naming it: kill it if it is still up (a child that
 * loaded but serves the wrong thing) and forget it either way.
 */
function abandonChild(pid: number, pidPath: string): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  try {
    unlinkSync(pidPath);
  } catch {
    /* never written or already dropped */
  }
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
      execSync(`taskkill /PID ${pid} /T /F`, {
        timeout: 5000,
        stdio: "ignore",
      });
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
    // Health on the port is ours only while our pid is alive: another
    // server answering there is not this daemon being up.
    healthy: pid !== null && h === "ok",
    loading: pid !== null && h === "loading",
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
  chat: DaemonStartResult;
  embedding: { pid: number } | { error: string } | { skipped: true };
}

export async function startChatAndEmbeddingDaemons(opts: {
  chat: DaemonStartOptions;
  embedding?: EmbeddingDaemonStartOptions;
}): Promise<StartBothResult> {
  const chatResult = await startDaemon(opts.chat);
  opts.chat.signal?.throwIfAborted();
  if (!opts.embedding) {
    return {
      chat: chatResult,
      embedding: { skipped: true },
    };
  }
  try {
    const embResult = await startEmbeddingDaemon({ ...opts.embedding, signal: opts.chat.signal ?? opts.embedding.signal });
    return {
      chat: chatResult,
      embedding: embResult,
    };
  } catch (e) {
    opts.chat.signal?.throwIfAborted();
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
      errors
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join("; "),
    );
  }
}
