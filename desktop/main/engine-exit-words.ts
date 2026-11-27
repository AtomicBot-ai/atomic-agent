/**
 * ATO-1739: the agent's words for why the managed model server failed,
 * mirrored from src/local-llm/server/engine-exit-reason.ts (PATTERNS) so the
 * desktop and the agent name one failure the same. The desktop is compiled
 * on its own (desktop/tsconfig.json, rootDir ".") and cannot import src/:
 * keep these patterns and their order in step with that file by hand.
 *
 * One deliberate difference: the agent's copy counts "unknown architecture"
 * and "unknown ggml type" as `model_file_corrupt`. Those mean a good file the
 * engine is too old for, so here they are `model_unsupported`. The agent's
 * copy needs the same split (a follow-up on main).
 *
 * The text read here (a server log, a failed start's message) can hold paths
 * and model names: callers keep it and pass on the word only.
 *
 * Pure: no fs, no Electron. The unit tests drive it straight.
 */

export type EngineExitWord =
  | "port_in_use" | "out_of_memory" | "model_file_missing" | "model_file_corrupt" | "model_unsupported" | "gpu_driver";

/** Ordered as the agent's PATTERNS: the first one that matches wins. */
export const ENGINE_EXIT_PATTERNS: ReadonlyArray<readonly [EngineExitWord, RegExp]> = [
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
    /invalid (?:gguf|magic)|not a gguf|failed to read (?:magic|header|key|tensor)|tensor [^\n]*(?:out of|not within) [^\n]*bounds|wrong number of tensors|corrupt/i,
  ],
  /* A good file the bundled engine is too old to read: llama.cpp says "unknown
     model architecture" for a model newer than it. Not damage, so never a
     reason to delete or download the file again. */
  ["model_unsupported", /unknown (?:model )?architecture|unknown (?:tensor|ggml) type|invalid ggml type/i],
  [
    "gpu_driver",
    /cuda driver version is insufficient|no cuda-capable device|ggml_cuda_init: failed|cuda error|cudaerror|vk_error|errordevicelost|device lost|failed to initialize vulkan|vulkan error|ggml_metal_init: error|failed to create metal|no gpu found|failed to load (?:cuda|vulkan|nvcuda)/i,
  ],
];

/** The agent's word for a text: the first pattern that matches anywhere in it, or null. */
export function engineExitWordIn(text: unknown): EngineExitWord | null {
  if (typeof text !== "string" || !text.trim()) return null;
  for (const [word, re] of ENGINE_EXIT_PATTERNS) if (re.test(text)) return word;
  return null;
}

/**
 * ATO-1745: a model file the server could not use because it is missing or
 * damaged, or null. A text that ran out of memory or lost its port first is
 * not a file problem, by the same order as the agent's.
 */
export function modelFileWordIn(text: unknown): "model_file_missing" | "model_file_corrupt" | null {
  const word = engineExitWordIn(text);
  return word === "model_file_missing" || word === "model_file_corrupt" ? word : null;
}

/**
 * Windows STATUS_DLL_INIT_FAILED (0xC0000142): a library the process needs
 * did not initialise, before it could write a line. Node reports the code
 * unsigned (3221225794); a signed reader sees -1073741502.
 */
export function isDllInitFailed(code: unknown): boolean {
  return code === 3221225794 || code === -1073741502;
}

/**
 * The managed server exited before it ever answered, as the agent words it
 * (src/local-llm/server/daemon-launch-guard.ts waitForOwnDaemon:
 * "<label> exited (code N) before it became healthy", or "(signal S)").
 * Only the code is read; null when the text says nothing of the kind.
 */
export function serverEarlyExitIn(text: unknown): { code: number | null } | null {
  if (typeof text !== "string") return null;
  const m = /exited \((?:code (-?\d+|unknown)|signal [A-Z0-9]+)\) before it became healthy/.exec(text);
  if (!m) return null;
  const code = m[1] !== undefined && m[1] !== "unknown" ? Number(m[1]) : null;
  return { code: Number.isFinite(code) ? code : null };
}
