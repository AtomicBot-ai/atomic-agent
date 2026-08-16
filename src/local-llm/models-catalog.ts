/**
 * Curated GGUF catalog (Qwen + Gemma + Nemotron). URLs mirror atomic-hermes
 * desktop local LLM models; `family` replaces UI-only icon fields.
 */

export type LocalModelId =
  | "qwen-3.5-4b"
  | "qwen-3.5-9b"
  | "qwen-3.5-35b"
  | "qwen-3.6-27b"
  | "qwen-3.6-35b-a3b"
  | "qwen-3.8-27b"
  | "gemma-4-e4b"
  | "gemma-4-12b"
  | "gemma-4-26b-a4b"
  | "gemma-4-31b"
  | "nemotron-3.5-30b-a3b";

/**
 * Memory-v2 phase 1B. Embedding model identifiers. A separate union
 * from `LocalModelId` so the type system prevents an embedding-only
 * model from accidentally being passed as a chat-completion target
 * (and vice versa). Both run through the same `llama-server` binary
 * but on a **second daemon process** with `--embeddings` enabled —
 * `llama-server` cannot serve `/completion` and `/embedding` from the
 * same instance because `--embeddings` forces pooling-only mode.
 */
export type EmbeddingModelId =
  | "nomic-embed-text-v1.5"
  | "bge-small-en-v1.5"
  | "bge-base-en-v1.5"
  | "bge-m3"
  | "jina-embeddings-v2-base-en";

export interface LocalModelDef {
  id: LocalModelId;
  name: string;
  filename: string;
  huggingFaceUrl: string;
  fileSizeGb: number;
  sizeLabel: string;
  description: string;
  maxContextLength: number;
  contextLabel: string;
  minRamGb: number;
  recommendedRamGb: number;
  family: "qwen" | "gemma" | "nemotron";
  /**
   * Jinja file under `assets/ai-models/` passed to llama-server as
   * `--chat-template-file`, overriding the template baked into the GGUF.
   *
   * **Invariant:** an override MUST preserve every reasoning marker
   * `detectModelProfile` keys on (`<think>` + `enable_thinking` for Qwen,
   * `<|channel>thought` + `<|turn>` for Gemma 4). llama-server echoes the
   * override back at `/props.chat_template`, which is the runtime's only
   * profile signal — a template without those markers demotes a thinking
   * model to `plain-instruct`, `buildGrammar` then drops the reasoning
   * prelude from the GBNF root, and the sampler is forced to open with `[`
   * and stalls in `ws` until `n_predict`. Prefer leaving this unset.
   */
  chatTemplateAsset?: string;
  tag?: string;
  /**
   * Vision capability flag. When `true`, the model has an associated
   * mmproj projector file that llama-server needs (via `--mmproj <path>`)
   * to enable multimodal input. The runtime uses this to gate the
   * `vision.describe` tool registration. Required when `mmprojUrl` is set.
   */
  supportsVision: boolean;
  /** HTTP URL of the mmproj GGUF projector file. Set iff `supportsVision`. */
  mmprojUrl?: string;
  /** On-disk filename for the projector. Set iff `supportsVision`. */
  mmprojFilename?: string;
  /** Approximate projector size in GB, surfaced in the TUI for download UX. */
  mmprojFileSizeGb?: number;
}

export const LOCAL_MODELS_CATALOG: readonly LocalModelDef[] = [
  {
    id: "gemma-4-e4b",
    name: "Gemma 4 E4B QAT GGUF",
    filename: "gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf",
    huggingFaceUrl:
      "https://huggingface.co/unsloth/gemma-4-E4B-it-qat-GGUF/resolve/main/gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf",
    fileSizeGb: 4.22,
    sizeLabel: "4.2 GB",
    description: "Compact multimodal reasoning (QAT)",
    maxContextLength: 131_072,
    contextLabel: "128K",
    minRamGb: 6,
    recommendedRamGb: 8,
    family: "gemma",
    supportsVision: true,
    mmprojUrl:
      "https://huggingface.co/unsloth/gemma-4-E4B-it-qat-GGUF/resolve/main/mmproj-BF16.gguf",
    mmprojFilename: "mmproj-BF16.gguf",
    mmprojFileSizeGb: 0.99,
  },
  {
    id: "gemma-4-12b",
    name: "Gemma 4 12B QAT GGUF",
    filename: "gemma-4-12B-it-qat-UD-Q4_K_XL.gguf",
    huggingFaceUrl:
      "https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF/resolve/main/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf",
    fileSizeGb: 6.72,
    sizeLabel: "6.7 GB",
    description: "Mid-size dense multimodal reasoning (QAT)",
    maxContextLength: 262_144,
    contextLabel: "256K",
    minRamGb: 8,
    recommendedRamGb: 12,
    family: "gemma",
    supportsVision: true,
    mmprojUrl:
      "https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF/resolve/main/mmproj-BF16.gguf",
    mmprojFilename: "mmproj-BF16.gguf",
    mmprojFileSizeGb: 0.175,
  },
  {
    id: "gemma-4-26b-a4b",
    name: "Gemma 4 26B-A4B QAT GGUF",
    filename: "gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf",
    huggingFaceUrl:
      "https://huggingface.co/unsloth/gemma-4-26B-A4B-it-qat-GGUF/resolve/main/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf",
    fileSizeGb: 14.25,
    sizeLabel: "14.2 GB",
    description: "Fast MoE with 256K context (QAT)",
    maxContextLength: 262_144,
    contextLabel: "256K",
    minRamGb: 16,
    recommendedRamGb: 20,
    family: "gemma",
    tag: "High Performance",
    supportsVision: true,
    mmprojUrl:
      "https://huggingface.co/unsloth/gemma-4-26B-A4B-it-qat-GGUF/resolve/main/mmproj-BF16.gguf",
    mmprojFilename: "mmproj-BF16.gguf",
    mmprojFileSizeGb: 1.19,
  },
  {
    id: "gemma-4-31b",
    name: "Gemma 4 31B QAT GGUF",
    filename: "gemma-4-31B-it-qat-UD-Q4_K_XL.gguf",
    huggingFaceUrl:
      "https://huggingface.co/unsloth/gemma-4-31B-it-qat-GGUF/resolve/main/gemma-4-31B-it-qat-UD-Q4_K_XL.gguf",
    fileSizeGb: 17.29,
    sizeLabel: "17.3 GB",
    description: "Top-tier dense reasoning (QAT)",
    maxContextLength: 262_144,
    contextLabel: "256K",
    minRamGb: 20,
    recommendedRamGb: 24,
    family: "gemma",
    tag: "High Performance",
    supportsVision: true,
    mmprojUrl:
      "https://huggingface.co/unsloth/gemma-4-31B-it-qat-GGUF/resolve/main/mmproj-BF16.gguf",
    mmprojFilename: "mmproj-BF16.gguf",
    mmprojFileSizeGb: 1.20,
  },
  {
    id: "qwen-3.8-27b",
    name: "Qwen 3.8 27B GGUF",
    filename: "Qwen3.8-27B-UD-Q4_K_XL.gguf",
    huggingFaceUrl:
      "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-UD-Q4_K_XL.gguf",
    fileSizeGb: 17.9,
    sizeLabel: "17.9 GB",
    description: "Latest dense agentic reasoning",
    maxContextLength: 262_144,
    contextLabel: "256K",
    minRamGb: 20,
    recommendedRamGb: 28,
    family: "qwen",
    tag: "New",
    supportsVision: true,
    mmprojUrl:
      "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/mmproj-F16.gguf",
    mmprojFilename: "mmproj-F16.gguf",
    mmprojFileSizeGb: 0.93,
  },
  {
    id: "qwen-3.6-27b",
    name: "Qwen 3.6 27B GGUF",
    filename: "Qwen3.6-27B-UD-Q4_K_XL.gguf",
    huggingFaceUrl:
      "https://huggingface.co/unsloth/Qwen3.6-27B-GGUF/resolve/main/Qwen3.6-27B-UD-Q4_K_XL.gguf",
    fileSizeGb: 17.6,
    sizeLabel: "17.6 GB",
    description: "Next-gen dense reasoning",
    maxContextLength: 262_144,
    contextLabel: "256K",
    minRamGb: 20,
    recommendedRamGb: 28,
    family: "qwen",
    supportsVision: true,
    mmprojUrl:
      "https://huggingface.co/unsloth/Qwen3.6-27B-GGUF/resolve/main/mmproj-F16.gguf",
    mmprojFilename: "mmproj-F16.gguf",
    mmprojFileSizeGb: 0.93,
  },
  {
    id: "qwen-3.6-35b-a3b",
    name: "Qwen 3.6 35B-A3B GGUF",
    filename: "Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf",
    huggingFaceUrl:
      "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf",
    fileSizeGb: 22.4,
    sizeLabel: "22.4 GB",
    description: "Next-gen agentic coding MoE",
    maxContextLength: 262_144,
    contextLabel: "256K",
    minRamGb: 24,
    recommendedRamGb: 36,
    family: "qwen",
    supportsVision: true,
    mmprojUrl:
      "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/mmproj-F16.gguf",
    mmprojFilename: "mmproj-F16.gguf",
    mmprojFileSizeGb: 0.90,
  },
  {
    id: "qwen-3.5-4b",
    name: "Qwen 3.5 4B GGUF",
    filename: "Qwen3.5-4B-Q4_K_M.gguf",
    huggingFaceUrl:
      "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf",
    fileSizeGb: 2.7,
    sizeLabel: "2.7 GB",
    description: "Quality-size sweet spot",
    maxContextLength: 262_144,
    contextLabel: "256K",
    minRamGb: 6,
    recommendedRamGb: 8,
    family: "qwen",
    supportsVision: true,
    mmprojUrl:
      "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/mmproj-F16.gguf",
    mmprojFilename: "mmproj-F16.gguf",
    mmprojFileSizeGb: 0.67,
  },
  {
    id: "qwen-3.5-9b",
    name: "Qwen 3.5 9B GGUF",
    filename: "Qwen3.5-9B-Q4_K_M.gguf",
    huggingFaceUrl:
      "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf",
    fileSizeGb: 5.3,
    sizeLabel: "5.3 GB",
    description: "Balanced performance",
    maxContextLength: 262_144,
    contextLabel: "256K",
    minRamGb: 10,
    recommendedRamGb: 16,
    family: "qwen",
    tag: "Recommended",
    supportsVision: true,
    mmprojUrl:
      "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/mmproj-F16.gguf",
    mmprojFilename: "mmproj-F16.gguf",
    mmprojFileSizeGb: 0.92,
  },
  {
    id: "qwen-3.5-35b",
    name: "Qwen 3.5 35B-A3B GGUF",
    filename: "Qwen3.5-35B-A3B-Q4_K_M.gguf",
    huggingFaceUrl:
      "https://huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF/resolve/main/Qwen3.5-35B-A3B-Q4_K_M.gguf",
    fileSizeGb: 22.0,
    sizeLabel: "22 GB",
    description: "High quality reasoning",
    maxContextLength: 262_144,
    contextLabel: "256K",
    minRamGb: 24,
    recommendedRamGb: 36,
    family: "qwen",
    tag: "High Performance",
    supportsVision: true,
    mmprojUrl:
      "https://huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF/resolve/main/mmproj-F16.gguf",
    mmprojFilename: "mmproj-F16.gguf",
    mmprojFileSizeGb: 0.90,
  },
  {
    id: "nemotron-3.5-30b-a3b",
    name: "NVIDIA Nemotron 3.5 Lightning 30B-A3B GGUF",
    filename: "NVIDIA-Nemotron-3.5-Lightning-30B-A3B-AD-IQ4_NL.gguf",
    huggingFaceUrl:
      "https://huggingface.co/AtomicChat/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF/resolve/main/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-AD-IQ4_NL.gguf",
    fileSizeGb: 19.65,
    sizeLabel: "19.7 GB",
    description: "Hybrid Mamba2 MoE reasoning, imatrix-calibrated",
    maxContextLength: 262_144,
    contextLabel: "256K",
    minRamGb: 24,
    recommendedRamGb: 32,
    family: "nemotron",
    tag: "New",
    supportsVision: false,
  },
];

export const DEFAULT_LLAMACPP_MODEL_ID: LocalModelId = "qwen-3.5-4b";

export function getLocalModelDef(id: LocalModelId): LocalModelDef {
  const found = LOCAL_MODELS_CATALOG.find((m) => m.id === id);
  if (!found) throw new Error(`unknown local model id: ${id}`);
  return found;
}

export function isKnownLocalModelId(raw: string): raw is LocalModelId {
  return LOCAL_MODELS_CATALOG.some((m) => m.id === raw);
}

/**
 * Embedding model definition. Mirrors `LocalModelDef` minus the chat
 * concerns (vision/mmproj, chat template, context length) and adds
 * embedding-specific fields (`dim`, `pooling`).
 *
 * The embedding daemon runs on its own port and is feature-gated by
 * `config.localModels.embeddings.enabled` — when disabled or the model
 * is not on disk, no second daemon is spawned and the memory subsystem
 * falls back to FTS5-only recall (memory-v2 phase 1B graceful
 * degradation).
 */
export interface EmbeddingModelDef {
  id: EmbeddingModelId;
  name: string;
  filename: string;
  huggingFaceUrl: string;
  fileSizeGb: number;
  sizeLabel: string;
  description: string;
  /** Output vector dimensionality emitted by `/embedding`. */
  dim: number;
  /** Pooling strategy passed to llama-server via `--pooling`. */
  pooling: "mean" | "last" | "cls" | "rank";
  minRamGb: number;
  recommendedRamGb: number;
}

/**
 * Curated embedding GGUFs. The catalog spans three quality tiers and
 * two language scopes so operators can pick a fit for their hardware
 * without leaving the TUI:
 *
 *  - **Ultra-light English** (`bge-small-en-v1.5`, 33 MB) — minimum
 *    viable hybrid recall on low-RAM hosts.
 *  - **General-purpose English** (`nomic-embed-text-v1.5`, 84 MB —
 *    catalog default; `bge-base-en-v1.5`, 118 MB; `jina-v2-base-en`,
 *    146 MB) — three 768-dim alternatives differing on training data
 *    and (for Jina) 8192-token context window.
 *  - **Multilingual SOTA** (`bge-m3`, 635 MB) — covers 100+ languages
 *    including Russian, 1024 dim, 8192 context. Heavier on disk but
 *    plug-and-play (no E5-style query/passage prefix scheme).
 *
 * All entries route to llama-server's `/embedding` endpoint and rely
 * on `--pooling` matching the model's training-time pooling head. A
 * mismatch silently produces garbage cosine similarities, so the
 * `pooling` field is load-bearing — verify against the model card
 * before changing.
 */
export const EMBEDDING_MODELS_CATALOG: readonly EmbeddingModelDef[] = [
  {
    id: "nomic-embed-text-v1.5",
    name: "Nomic Embed Text v1.5",
    filename: "nomic-embed-text-v1.5.Q4_K_M.gguf",
    huggingFaceUrl:
      "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf",
    fileSizeGb: 0.084,
    sizeLabel: "84 MB",
    description: "General-purpose 768-dim text embeddings",
    dim: 768,
    pooling: "mean",
    minRamGb: 1,
    recommendedRamGb: 2,
  },
  {
    id: "bge-small-en-v1.5",
    name: "BGE Small English v1.5",
    filename: "bge-small-en-v1.5-q8_0.gguf",
    huggingFaceUrl:
      "https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q8_0.gguf",
    fileSizeGb: 0.034,
    sizeLabel: "33 MB",
    description: "Compact English 384-dim embeddings",
    dim: 384,
    pooling: "cls",
    minRamGb: 1,
    recommendedRamGb: 1,
  },
  {
    id: "bge-base-en-v1.5",
    name: "BGE Base English v1.5",
    filename: "bge-base-en-v1.5-q8_0.gguf",
    huggingFaceUrl:
      "https://huggingface.co/CompendiumLabs/bge-base-en-v1.5-gguf/resolve/main/bge-base-en-v1.5-q8_0.gguf",
    fileSizeGb: 0.118,
    sizeLabel: "118 MB",
    description: "Higher-quality English 768-dim embeddings (BGE base)",
    dim: 768,
    pooling: "cls",
    minRamGb: 1,
    recommendedRamGb: 2,
  },
  {
    id: "bge-m3",
    name: "BGE-M3 Multilingual",
    filename: "bge-m3-Q8_0.gguf",
    huggingFaceUrl:
      "https://huggingface.co/lm-kit/bge-m3-gguf/resolve/main/bge-m3-Q8_0.gguf",
    fileSizeGb: 0.635,
    sizeLabel: "635 MB",
    description:
      "Multilingual SOTA (100+ langs incl. Russian), 1024-dim, 8192 ctx",
    dim: 1024,
    pooling: "cls",
    minRamGb: 2,
    recommendedRamGb: 4,
  },
  {
    id: "jina-embeddings-v2-base-en",
    name: "Jina Embeddings v2 Base English",
    filename: "jina-embeddings-v2-base-en-Q8_0.gguf",
    huggingFaceUrl:
      "https://huggingface.co/second-state/jina-embeddings-v2-base-en-GGUF/resolve/main/jina-embeddings-v2-base-en-Q8_0.gguf",
    fileSizeGb: 0.146,
    sizeLabel: "146 MB",
    description:
      "English 768-dim with 8192-token context (ALiBi long-doc embeddings)",
    dim: 768,
    pooling: "mean",
    minRamGb: 1,
    recommendedRamGb: 2,
  },
];

export const DEFAULT_EMBEDDING_MODEL_ID: EmbeddingModelId =
  "nomic-embed-text-v1.5";

export function getEmbeddingModelDef(id: EmbeddingModelId): EmbeddingModelDef {
  const found = EMBEDDING_MODELS_CATALOG.find((m) => m.id === id);
  if (!found) throw new Error(`unknown embedding model id: ${id}`);
  return found;
}

export function isKnownEmbeddingModelId(
  raw: string,
): raw is EmbeddingModelId {
  return EMBEDDING_MODELS_CATALOG.some((m) => m.id === raw);
}
