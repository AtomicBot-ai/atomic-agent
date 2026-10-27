import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DownloadFileOptions } from "../downloads/download-file.js";
import { resolveLogFilePath } from "../backend-paths.js";
import { installCoreBackend } from "../core/core-backend.js";
import { isCoreWindowsCpuBackend } from "../core/core-backend-choice.js";
import { CoreRequestError } from "../core/core-client.js";
import { activeCoreVersion, coreVersionDir, readCoreBackend, writeCoreJson, type CoreBackend } from "../core/core-state.js";
import { stopChatAndEmbeddingDaemons } from "../server/daemon-lifecycle.js";
import { readLogTail } from "../server/log-tail.js";
import { currentRunLog } from "../server/server-fault.js";
import {
  getConfiguredCoreBackendVariant,
  setConfiguredCoreBackendVariant,
  type CoreBackendVariant,
} from "./windows-backend-variant.js";

/** The one line both start paths print when they move this machine to the CPU build. */
export const CORE_CPU_FALLBACK_LINE =
  "Atomic Chat's GPU build crashed while loading the model on this computer, so local models are falling back to the CPU build (slower).";

/** The line both start paths print once the CPU build served the model and the choice is saved. */
export const CORE_CPU_RECORDED_LINE =
  'recorded coreBackendVariant "cpu" in config.json — to try the GPU build again (e.g. after a driver update), set it to "auto" and run: atomic-agent models update';

/**
 * llama.cpp's own words for a model it cannot read: an architecture or a
 * tensor type it does not know, a damaged or truncated file. Any build
 * fails these the same way.
 */
const MODEL_LEVEL =
  /unknown (model )?architecture|unknown (tensor|ggml) type|invalid ggml type|tensor .*(out of|not within) .*bounds|wrong number of tensors|corrupt/i;

/**
 * Failures the CPU build would hit just the same, so they never cause the
 * switch: memory, a missing or unreadable model file, a model llama.cpp
 * cannot read, a port or a session already taken, Core's load timeout
 * (a slow load, or a hang that a CPU build would not be sure to fix).
 * Matched against Core's message and code.
 */
const NOT_A_BUILD_CRASH = [
  MODEL_LEVEL,
  /time(d)? ?out|timeout/i,
  /out of (device |host )?memory|\boom\b|failed to allocate|cannot allocate|not enough memory|insufficient memory|outofdevicememory|cudamalloc|_memory\b/i,
  /no such file|not found|does not exist|cannot find|enoent|failed to open|invalid (gguf|magic)|not a gguf|_not_found\b/i,
  /address already in use|eaddrinuse|(couldn't|could not|failed to) bind|port .*(in use|busy|taken)|already (running|loaded)|_port\b|_busy\b|conflict/i,
];

/**
 * The same, read from this run's server log, where llama.cpp names an
 * allocation failure or an unopenable file that Core's answer may not
 * repeat. Narrower than the message patterns: a normal llama-server log
 * says "binding port" and "not found" about optional pieces.
 */
const NOT_A_BUILD_CRASH_IN_LOG = [
  MODEL_LEVEL,
  /out of (device |host )?memory|outofdevicememory|failed to allocate|cudamalloc failed|unable to allocate|couldn't bind|failed to open gguf|no such file or directory/i,
];

/**
 * Core's answer to a model load that broke inside the backend: a 5xx, or
 * a code that names a load failure. A 4xx refusal (bad request, unknown
 * model) is not a crash.
 */
function isCoreLoadFailure(error: unknown): error is CoreRequestError {
  if (!(error instanceof CoreRequestError)) return false;
  return error.status >= 500 || /LOAD|CRASH/i.test(error.code ?? "");
}

/**
 * Whether a failed Atomic Core model start means the installed GPU build
 * (Vulkan, CUDA) crashes on this computer, so the CPU build should be
 * tried once. Conservative on purpose, since a wrong switch leaves the
 * machine on a much slower build: Windows x64 only (Windows on ARM has
 * one build), `coreBackendVariant` still `"auto"` (`"cpu"` is already
 * there), the active Core backend a GPU build, and the error Core's own
 * load failure that names neither memory, a missing or unreadable model,
 * a busy port nor a timeout, in its text or in this run's log. Pure.
 */
export function shouldFallBackToCoreCpuBuild(opts: {
  /** `readCoreBackend(dataDir)?.backend`: the active Core backend id. */
  installedBackend: string | undefined;
  /** Configured `localModels.managed.coreBackendVariant`. */
  configuredVariant: CoreBackendVariant;
  /** What `startDaemon` / `startChatAndEmbeddingDaemons` rejected with. */
  error: unknown;
  /** The current run's server log (Core appends its llama-server output there). */
  logText?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): boolean {
  if ((opts.platform ?? process.platform) !== "win32") return false;
  if ((opts.arch ?? process.arch) !== "x64") return false;
  if (opts.configuredVariant !== "auto") return false;
  if (!opts.installedBackend || isCoreWindowsCpuBackend(opts.installedBackend)) return false;
  if (!isCoreLoadFailure(opts.error)) return false;
  const text = `${opts.error.message} ${opts.error.code ?? ""}`;
  if (NOT_A_BUILD_CRASH.some(pattern => pattern.test(text))) return false;
  const log = opts.logText ?? "";
  return !NOT_A_BUILD_CRASH_IN_LOG.some(pattern => pattern.test(log));
}

/** The current run's tail of the chat server log, or "" when there is none. */
function readCurrentRunLog(dataDir: string): string {
  try {
    const path = resolveLogFilePath(dataDir);
    return existsSync(path) ? currentRunLog(readLogTail(path, 64 * 1024).text) : "";
  } catch {
    return "";
  }
}

/**
 * `shouldFallBackToCoreCpuBuild` for a start that just failed on the
 * Atomic Core engine, reading the installed backend, the configured
 * `coreBackendVariant` and the log itself.
 */
export function coreCpuFallbackApplies(dataDir: string, error: unknown): boolean {
  return shouldFallBackToCoreCpuBuild({
    installedBackend: readCoreBackend(dataDir)?.backend,
    configuredVariant: getConfiguredCoreBackendVariant(),
    error,
    logText: readCurrentRunLog(dataDir),
  });
}

/** What `fallBackToCoreCpuBuild` replaced, so a failed retry can put it back. */
export interface CoreCpuSwap {
  tag: string;
  /** The GPU build's `backend.json` record before the swap. */
  previous: CoreBackend | null;
  /** `coreBackendVariant` before the swap (`"auto"`). */
  previousVariant: CoreBackendVariant;
}

/**
 * Install Core's CPU build for one retry: flip the in-process
 * `coreBackendVariant` to `"cpu"` (so `installCoreBackend` picks the CPU
 * build from Core's catalog, `chooseCoreBackend`), write one line to the
 * server log, stop whatever the failed start left (a half-loaded model,
 * Core's embedding module, which would make the install refuse), then
 * install it, which rewrites `backend.json`. Nothing is persisted: the
 * caller records `coreBackendVariant: "cpu"` only after the retry on
 * device `cpu` served the model, and calls `revertCoreCpuFallback` when
 * it did not. A failed install restores the in-process variant and
 * rethrows; `backend.json` is untouched then.
 */
export async function fallBackToCoreCpuBuild(
  dataDir: string,
  opts: DownloadFileOptions = {},
): Promise<CoreCpuSwap> {
  const previous = readCoreBackend(dataDir);
  const previousVariant = getConfiguredCoreBackendVariant();
  setConfiguredCoreBackendVariant("cpu");
  try {
    // One line in the server log, where a support reader looks for why the build changed.
    appendFileSync(resolveLogFilePath(dataDir), `[atomic-agent] ${CORE_CPU_FALLBACK_LINE}\n`);
  } catch {
    /* a log that cannot be written must not block the switch */
  }
  try {
    await stopChatAndEmbeddingDaemons(dataDir);
  } catch {
    // Best-effort: the install says plainly when a model still runs.
  }
  try {
    const { tag } = await installCoreBackend(dataDir, opts);
    return { tag, previous, previousVariant };
  } catch (err) {
    setConfiguredCoreBackendVariant(previousVariant);
    throw err;
  }
}

/**
 * The CPU build did not serve the model either, so it was not the GPU
 * build's fault: go back. Restores the in-process variant and, when the
 * GPU build's binary is still on disk and its Core version is still the
 * active one, its `backend.json` record, so the next start loads the
 * GPU build again without a download. Otherwise the record stays on the
 * CPU build until the next install, which takes Core's recommendation
 * again. Never throws.
 */
export function revertCoreCpuFallback(dataDir: string, swap: CoreCpuSwap): void {
  setConfiguredCoreBackendVariant(swap.previousVariant);
  const previous = swap.previous;
  if (!previous || !existsSync(previous.binary)) return;
  try {
    if (activeCoreVersion(dataDir) !== previous.coreVersion) return;
    writeCoreJson(join(coreVersionDir(dataDir, previous.coreVersion), "backend.json"), previous);
  } catch {
    /* the next install takes the recommendation again */
  }
}
