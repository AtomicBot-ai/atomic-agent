import type { LocalModelDef } from "../../local-llm/catalog/models-catalog.js";
import type { BackendVariantPreference } from "../../local-llm/backend/windows-backend-variant.js";
import type { SwaFullPreference } from "../../local-llm/server/swa-full.js";

export type LocalLlmMode = "external" | "managed";

/**
 * A three-way local-template switch: `auto` lets the runtime decide per
 * model family, `on` / `off` force it. Used by
 * `localModels.useServerTemplate` and `localModels.thinking`.
 */
export type LocalTemplateSetting = "auto" | "on" | "off";

export interface UserManagedLocalLlmConfig {
  modelId: string | null;
  port: number;
  dataDirOverride: string | null;
  /**
   * When true, managed-mode start (TUI auto-start / `s`, CLI
   * `models start`) checks GitHub Releases and replaces the llama.cpp
   * zip if a newer tag (or a stale Windows variant) is available.
   * Default `true` since config v41. Older files stored an unused
   * `false` default — those migrate to `true`. Set `false` to pin the
   * installed backend.
   */
  autoUpdate: boolean;
  /**
   * Compute-device preference for the managed llama.cpp daemon:
   *   - `"auto"` (default) — enumerate via `llama-server --list-devices`
   *     at start and pick the best discrete GPU; CPU fallback when none.
   *   - a concrete backend device id (e.g. `"Vulkan0"`) — pin offload to
   *     that device.
   *   - `"cpu"` — force CPU-only (`-ngl 0`).
   * Resolved in `startDaemon` via `resolveManagedDevice`.
   */
  device: string;
  /**
   * Which llama.cpp build (release zip) the managed backend installs.
   * Windows-only — every other platform, Linux arm64 included,
   * publishes a single asset, so there is nothing for the preference to
   * choose between and it is ignored there.
   *   - `"auto"` (default) — probe `nvidia-smi`: the cuda-12.4 build for
   *     a driver reporting CUDA >= 12.4, Vulkan for Blackwell cards
   *     (12.4 has no code for them), older drivers and no NVIDIA GPU.
   *     Never cuda-13.3 while that zip ships without its CUDA runtime
   *     (ATO-244, see `selectWindowsBackendAsset`).
   *   - `"cpu"` — the CPU-only build. For machines whose Vulkan stack
   *     cannot load a model at all (iGPU-only boxes); also written back
   *     automatically when a GPU build fails to serve (see
   *     `cpu-backend-fallback.ts`). Distinct from `device: "cpu"`, which
   *     only disables offload — the broken compute backend would still
   *     be baked into the binary.
   *   - `"vulkan"` / `"cuda-12.4"` / `"cuda-13.3"` — pin that build
   *     (and undo an automatic CPU fallback after a driver fix). A pinned
   *     `"cuda-13.3"` needs the CUDA Toolkit's runtime on the PATH.
   * Added in config v47; older files transparently get `"auto"`.
   */
  backendVariant: BackendVariantPreference;
  /**
   * llama-server context window (`--ctx-size`) for the managed chat
   * daemon.
   *   - `0` (default) — auto: fit the context to the target device's
   *     free VRAM at start (see `estimateContextSize`); on a device that
   *     shares the system's RAM (Apple silicon, an integrated GPU) also
   *     leaving the system its headroom and the cache within its share of
   *     physical memory (`resolveContextKvBudgetMiB`).
   *   - a positive value — pin `--ctx-size` exactly, clamped only to the
   *     model's trained context ceiling.
   */
  contextSize: number;
  /**
   * Multi-GPU tensor split for the managed chat daemon. Empty (the
   * default) keeps the single-device behavior: `device` auto-picks the
   * best GPU and pins offload there. Two or more non-negative ratios
   * (at least one positive, e.g. `[3, 1]` for a 75%/25% split) launch
   * llama-server with `--split-mode layer --tensor-split <ratios>` so
   * the model's layers spread across GPUs proportionally. With
   * `device: "auto"` no single device is pinned — llama.cpp sees every
   * GPU; an explicit comma-separated `device` list (e.g.
   * `"Vulkan0,Vulkan1"`) restricts the split to those devices.
   * `device: "cpu"` wins over this field and disables splitting. The
   * embedding daemon is never split — it keeps pinning one device.
   * Added in config v48; older files inherit `[]` transparently.
   */
  tensorSplit: number[];
  /**
   * llama-server request slots (`--parallel`) for the managed chat
   * daemon: `"auto"` (the default since config v63) or a pinned 1..8.
   *
   * Fusion workers run one per slot, so this is the ceiling on how many
   * of them run at once rather than queueing. `"auto"` derives it from
   * the context the daemon is launched with — llama.cpp divides that
   * context between the slots, and a slot smaller than a worker's own
   * prompt cannot serve one (see `worker-slots.ts`). That makes the
   * number a property of the machine, which is the party that knows it.
   *
   * `"auto"` also reads which way fusion is pointing. With the legs
   * swapped — a local orchestrator and cloud workers — the daemon serves
   * exactly one stream, so it launches with one slot: a second one
   * cannot be used and is not free (see `local-leg-role.ts`).
   *
   * A pinned number is honoured as written, in either direction: an
   * external server, an unusual model, a benchmark. Applied on the next
   * daemon start.
   */
  parallel: number | "auto";
  /**
   * `--swa-full` for a sliding-window model (Gemma 4 and kin): keep the
   * whole context in the sliding layers so a partially matching prompt
   * reuses its matching prefix instead of re-reading everything — at a
   * several-fold KV cost for those layers.
   *   - `"auto"` (default) — on when the full-SWA KV estimate fits the
   *     launch's memory budget (see `swa-full.ts`), else off.
   *   - `"on"` / `"off"` — always / never.
   * Models without sliding-window layers ignore it. Applied on the next
   * daemon start.
   */
  swaFull: SwaFullPreference;
  /**
   * Stop the managed chat daemon when the last CLI session exits.
   * `true` (default) — closing the terminal frees the RAM/VRAM the
   * model was holding; a second live session keeps the daemon up (see
   * `session-registry.ts`). `false` — keep the model warm between
   * sessions; the operator stops it via `atomic-agent models stop`.
   * Standalone daemons started with `models start` are never touched.
   * Added in config v34; older files transparently get `true`.
   */
  stopOnExit: boolean;
  /**
   * Bring the managed chat daemon back by itself when it dies (or, from
   * the wedge watchdog, stops answering) while this TUI owns it. `true`
   * (default): a crashed or killed llama-server is restarted within a
   * few seconds and a parked turn resumes on it; three deaths within a
   * minute of their start stop the retries and name the fault. `false`:
   * a dead daemon stays dead until `/llm restart` or `R`. Files that
   * predate the key get `true`.
   */
  autoRestart: boolean;
}

/**
 * How model and backend files are fetched. Added in config v52.
 * `connections` is the number of parallel HTTP range requests one file
 * is split across (1–64). Hugging Face's CDN caps each connection, so
 * one stream is slow regardless of the link; `1` restores the old
 * single-stream behaviour. The `ATOMIC_AGENT_DOWNLOAD_CONNECTIONS` env
 * var, when set, wins over this file value (operator override).
 */
export interface LocalModelDownloadConfig {
  connections: number;
  /**
   * Origin that serves Hugging Face for this install (config v53), e.g.
   * a regional mirror. Catalogue and custom-model URLs stay canonical
   * `https://huggingface.co/...`; the endpoint is applied at request
   * time, so switching it never invalidates a partial download. The
   * `HF_ENDPOINT` env var (what `huggingface_hub` honours) wins over
   * this value when set.
   */
  hfEndpoint: string;
}

/**
 * Memory-v2 phase 1B. Second managed `llama-server` instance dedicated
 * to `/embedding`. Lives next to the chat daemon in `<stateDir>/llamacpp/`
 * but runs as a separate OS process on its own port. The reason is
 * structural: `--embeddings` switches llama-server to pooling-only
 * mode, so the same process cannot serve `/completion` and `/embedding`
 * simultaneously.
 *
 * Lifecycle is tied to the chat daemon at the CLI level
 * (`atomic-agent models start` brings both up, `models stop` brings
 * both down) but failure isolation is preserved: if the embedding
 * daemon refuses to start, the chat daemon still runs and the memory
 * subsystem transparently falls back to FTS5-only recall.
 *
 * `enabled=false` (default) ⇒ no second daemon, no embedding writes,
 * no hybrid recall — observably identical to phase 1A.
 */
export interface UserManagedEmbeddingLlmConfig {
  enabled: boolean;
  /** `EmbeddingModelId` from the catalog, or `null` when not chosen. */
  modelId: string | null;
  port: number;
  /** Base URL of the embedding-only llama-server. */
  url: string;
}

export interface RuntimeLocalModelsConfig {
  url: string;
  apiKey: string | null;
  healthPath: string;
  completionPath: string;
  /** Upper bound on `n_predict` for each completion when the caller omits `maxTokens`. */
  completionMaxTokens: number;
  healthTimeoutMs: number;
  /**
   * For a unary `complete()`, the whole-request budget. For
   * `completeStream()`, an **idle** budget: how long llama-server may
   * stay silent between bytes once the reply has started. A healthy
   * generation refreshes it on every chunk, so it never caps how long
   * an answer may be — see `streamTotalTimeoutMs` for that — and it
   * does not bound the wait for the first byte — see
   * `firstTokenTimeoutMs`.
   */
  requestTimeoutMs: number;
  /**
   * How long a `completeStream()` may wait for its FIRST byte, from the
   * moment the request is sent. That wait is queueing behind busy slots
   * plus prompt evaluation — on one GPU shared by several fusion
   * workers, legitimately many minutes — so it has its own budget
   * rather than `requestTimeoutMs`: at 300 s a queued worker whose slot
   * had not evaluated a single token was cancelled as if the server
   * were dead. Never shorter than `requestTimeoutMs` in effect.
   * Env-only, like the other local-LLM timeouts:
   * `ATOMIC_AGENT_LLAMA_FIRST_TOKEN_TIMEOUT_MS`.
   */
  firstTokenTimeoutMs: number;
  /**
   * Absolute cap on one streaming response, measured from the moment
   * response headers arrive. `requestTimeoutMs` only bounds silence,
   * so without this a server dribbling one byte just under the idle
   * budget would pin a slot, a session and — in headless `run` — a
   * process forever. Deliberately far above any honest local
   * generation; it is a backstop, not a budget.
   */
  streamTotalTimeoutMs: number;
  healthRetries: number;
  healthRetryBackoffMs: number;
  /**
   * Maximum number of attempts for `complete()` and the initial
   * non-streaming fetch of `completeStream()`. Retries apply only to
   * transport-level errors (network failures, HTTP 5xx) — 4xx grammar
   * or validation errors short-circuit immediately.
   */
  completionRetries: number;
  /** Base delay between completion retries; grows exponentially with jitter. */
  completionRetryBackoffMs: number;
  defaultSlotId: number;
  /** `external` uses `url`; `managed` overrides runtime `url` to localhost + `managed.port`. */
  mode: LocalLlmMode;
  /** Mirrors `UserConfigFile.localModels.useServerTemplate`. */
  useServerTemplate: LocalTemplateSetting;
  /** Mirrors `UserConfigFile.localModels.thinking`. */
  thinking: LocalTemplateSetting;
  /** Mirrors `UserConfigFile.localModels.reasoningBudgetTokens`. */
  reasoningBudgetTokens: number;
  managed: UserManagedLocalLlmConfig;
  /**
   * Memory-v2 phase 1B. Second managed daemon for `/embedding`.
   * Mirrors `UserConfigFile.localModels.embeddings`. The runtime
   * connects to `http://127.0.0.1:<embeddings.port>` for embedding
   * requests when `embeddings.enabled` is true and the daemon is
   * healthy. Disabled / unreachable ⇒ FTS5-only recall path.
   */
  embeddings: UserManagedEmbeddingLlmConfig;
  /** Parallel-connection download settings (config v52). */
  download: LocalModelDownloadConfig;
}

export interface UserLocalModelsConfig {
  url: string;
  mode: LocalLlmMode;
  /**
   * Upper bound on `n_predict` for grammar-constrained tool-call
   * completions. Added in config v7 to let users raise the cap
   * without juggling the `ATOMIC_AGENT_LLAMA_MAX_TOKENS` env var.
   * Range [64, 131072]. The env var, when set, still wins over
   * this file value (operator override).
   */
  completionMaxTokens: number;
  /**
   * Render local prompts through the model's own chat template
   * (llama-server `POST /apply-template`) instead of atag's hand-built
   * framing. `auto` (default) uses the template for every family
   * without a hand-built profile — everything but Gemma and Qwen —
   * so Llama, GLM, Mistral and other GGUFs get their turn markers.
   * `on` forces it for every model, `off` keeps the raw framing.
   * The GBNF grammar applies either way. Added in config v66.
   */
  useServerTemplate: LocalTemplateSetting;
  /**
   * The template's thinking switch (`chat_template_kwargs:
   * {enable_thinking}`) on server-templated prompts, for families
   * whose template reads it. `auto` (default) leaves the template's
   * own default; `on` / `off` set it. Added in config v66. Since v68
   * `off` also reaches the hand-built prompt of a `qwen-think` model:
   * the prompt ends with the template's own disabled marker and the
   * grammar drops the reasoning prelude.
   */
  thinking: LocalTemplateSetting;
  /**
   * How many tokens a local reasoning model may spend thinking before
   * a tool call, on the grammar path. The GBNF prelude bounds the
   * think block at `reasoningBudgetTokens × 4` characters; past that
   * the sampler admits only the close sentinel, so the model is forced
   * to close the block and emit the call. `0` leaves the prelude
   * unbounded. The forced final step (`reply` / `finish`) is never
   * cut. Range `0` or [64, 32768]. Added in config v68.
   */
  reasoningBudgetTokens: number;
  managed: UserManagedLocalLlmConfig;
  /**
   * Memory-v2 phase 1B. Optional second managed daemon for
   * embeddings. Added in config v12; older files are upgraded with
   * `{ enabled: false, modelId: null, port: 19092 }`.
   */
  embeddings: UserManagedEmbeddingLlmConfig;
  /** Parallel-connection download settings (config v52). */
  download: LocalModelDownloadConfig;
  /**
   * GGUF models the operator added from an arbitrary Hugging Face repo
   * (config v44). Each entry is a whole `LocalModelDef` with a
   * `custom-` prefixed id; `loadConfig()` publishes them to the catalog
   * registry so curated and added models resolve through one lookup.
   * Older files inherit `[]`.
   */
  customModels: LocalModelDef[];
}
