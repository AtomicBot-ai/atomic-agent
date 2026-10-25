import { appendFileSync, existsSync } from "node:fs";
import type { DownloadFileOptions } from "../downloads/download-file.js";
import { resolveLogFilePath } from "../backend-paths.js";
import { installCoreBackend } from "../core/core-backend.js";
import { isCoreWindowsCpuBackend } from "../core/core-backend-choice.js";
import { CoreRequestError } from "../core/core-client.js";
import { readCoreBackend } from "../core/core-state.js";
import { stopChatAndEmbeddingDaemons } from "../server/daemon-lifecycle.js";
import { readLogTail } from "../server/log-tail.js";
import { currentRunLog } from "../server/server-fault.js";
import {
  setConfiguredBackendVariant,
  type BackendVariantPreference,
} from "./windows-backend-variant.js";

/** The one line both start paths print when they move this machine to the CPU build. */
export const CORE_CPU_FALLBACK_LINE =
  "Atomic Chat's GPU build crashed while loading the model on this computer, so local models are falling back to the CPU build (slower).";

/**
 * Failures the CPU build would hit just the same, so they never cause the
 * switch: memory, a missing or unreadable model file, a port or a session
 * already taken. Matched against Core's message and code.
 */
const NOT_A_BUILD_CRASH = [
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
const NOT_A_BUILD_CRASH_IN_LOG =
  /out of (device |host )?memory|outofdevicememory|failed to allocate|cudamalloc failed|unable to allocate|couldn't bind|failed to open gguf|no such file or directory/i;

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
 * one build), `backendVariant` still `"auto"` (a pin is the operator's
 * call; `"cpu"` is already there), the active Core backend a GPU build,
 * and the error Core's own load failure that names neither memory, a
 * missing file nor a busy port, in its text or in this run's log. Pure.
 */
export function shouldFallBackToCoreCpuBuild(opts: {
  /** `readCoreBackend(dataDir)?.backend`: the active Core backend id. */
  installedBackend: string | undefined;
  configuredVariant: BackendVariantPreference;
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
  return !NOT_A_BUILD_CRASH_IN_LOG.test(opts.logText ?? "");
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
 * variant and the log itself.
 */
export function coreCpuFallbackApplies(
  dataDir: string,
  configuredVariant: BackendVariantPreference,
  error: unknown,
): boolean {
  return shouldFallBackToCoreCpuBuild({
    installedBackend: readCoreBackend(dataDir)?.backend,
    configuredVariant,
    error,
    logText: readCurrentRunLog(dataDir),
  });
}

/**
 * Move this machine to Core's CPU build: flip the in-process variant to
 * `"cpu"` (so `installCoreBackend` picks the CPU build from Core's
 * catalog, `chooseCoreBackend`), stop whatever the failed start left
 * (a half-loaded model, Core's embedding module, which would make the
 * install refuse), then install it, which rewrites `backend.json`.
 * Writes one line to the server log saying so.
 * Persisting `backendVariant: "cpu"` is the caller's job, as for the
 * llama-server engine's rescue; the caller retries the start once on
 * device `cpu`.
 */
export async function fallBackToCoreCpuBuild(
  dataDir: string,
  opts: DownloadFileOptions = {},
): Promise<{ tag: string }> {
  setConfiguredBackendVariant("cpu");
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
  const { tag } = await installCoreBackend(dataDir, opts);
  return { tag };
}
