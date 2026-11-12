import { resolveLogFilePath } from "../backend-paths.js";
import { readLogTail } from "./log-tail.js";
import { currentRunLog } from "./server-fault.js";

/**
 * Why the managed engine's process is gone, as one fixed word for an error
 * report (ATO-1435). Read from the tail of the chat server's log, which
 * llama-server and the Atomic Core session both write
 * (`resolveLogFilePath`), by fixed patterns only. The log text never leaves
 * this module: its lines can carry prompt text, paths and model names.
 *
 *   - `out_of_memory`       the backend could not allocate (CUDA, Metal,
 *                           Vulkan or host memory).
 *   - `model_file_missing`  the model file could not be opened.
 *   - `model_file_corrupt`  llama.cpp could not read the model: a bad magic,
 *                           an unknown architecture or tensor type, a
 *                           truncated file.
 *   - `gpu_driver`          the GPU backend or its driver failed to start.
 *   - `port_in_use`         the server could not take its port.
 *   - `crashed_unknown`     the log has lines, none of them recognised.
 *   - `no_log`              there is no log, or it is empty.
 */
export type EngineExitReason =
  | "out_of_memory"
  | "model_file_missing"
  | "model_file_corrupt"
  | "gpu_driver"
  | "port_in_use"
  | "crashed_unknown"
  | "no_log";

/** How much of the log is read: the end of the last run is what says why. */
export const ENGINE_EXIT_LOG_BYTES = 64 * 1024;

/**
 * Ordered: the first match wins. A port taken stops the server before it
 * loads anything. Memory comes before the file and GPU checks, since a GPU
 * that ran out of memory also prints CUDA or Metal errors and a load that
 * ran out of memory can end in "failed to load model". A missing file comes
 * before a corrupt one, whose read errors can follow it. Patterns are the ones
 * already used to judge Core's load failures (`core-cpu-backend-fallback.ts`)
 * and the server's own faults (`server-fault.ts`).
 */
const PATTERNS: ReadonlyArray<readonly [EngineExitReason, RegExp]> = [
  ["port_in_use", /couldn't bind http server socket|address already in use|eaddrinuse|(?:could not|failed to) bind/i],
  [
    "out_of_memory",
    /kiogpucommandbuffercallbackerroroutofmemory|out of (?:device |host )?memory|outofdevicememory|failed to allocate|cannot allocate|unable to allocate|not enough memory|insufficient memory|cudamalloc failed/i,
  ],
  [
    "model_file_missing",
    /failed to open gguf file[^\n]*(?:no such file|not found|cannot find)|no such file or directory|model (?:file )?(?:not found|does not exist)/i,
  ],
  [
    "model_file_corrupt",
    /invalid (?:gguf|magic)|not a gguf|failed to read (?:magic|header|key|tensor)|unknown (?:model )?architecture|unknown (?:tensor|ggml) type|invalid ggml type|tensor [^\n]*(?:out of|not within) [^\n]*bounds|wrong number of tensors|corrupt/i,
  ],
  [
    "gpu_driver",
    /cuda driver version is insufficient|no cuda-capable device|ggml_cuda_init: failed|cuda error|cudaerror|vk_error|errordevicelost|device lost|failed to initialize vulkan|vulkan error|ggml_metal_init: error|failed to create metal|no gpu found|failed to load (?:cuda|vulkan|nvcuda)/i,
  ],
];

/** The word for a log's text; `no_log` for nothing to read. */
export function classifyEngineExitReason(logText: string): EngineExitReason {
  const scoped = currentRunLog(logText);
  if (scoped.trim() === "") return "no_log";
  for (const [reason, pattern] of PATTERNS) {
    if (pattern.test(scoped)) return reason;
  }
  return "crashed_unknown";
}

/**
 * The word for the managed engine's log under `dataDir`. A log that is not
 * there or cannot be read is `no_log`. Never throws.
 */
export function readEngineExitReason(
  dataDir: string,
  readTail: (path: string, maxBytes: number) => string = (path, maxBytes) => readLogTail(path, maxBytes).text,
): EngineExitReason {
  let text: string;
  try {
    text = readTail(resolveLogFilePath(dataDir), ENGINE_EXIT_LOG_BYTES);
  } catch {
    return "no_log";
  }
  return classifyEngineExitReason(text);
}
