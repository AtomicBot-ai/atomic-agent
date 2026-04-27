/**
 * Curated GGUF catalog (Qwen + Gemma only). URLs mirror atomic-hermes
 * desktop local LLM models; `family` replaces UI-only icon fields.
 */

export type LocalModelId =
  | "qwen-3.5-4b"
  | "qwen-3.5-9b"
  | "qwen-3.5-35b"
  | "qwen-3.6-27b"
  | "qwen-3.6-35b-a3b"
  | "gemma-4-e4b"
  | "gemma-4-26b-a4b"
  | "gemma-4-31b";

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
  family: "qwen" | "gemma";
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
    name: "Gemma 4 E4B GGUF",
    filename: "gemma-4-E4B-it-Q4_K_M.gguf",
    huggingFaceUrl:
      "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf",
    fileSizeGb: 4.98,
    sizeLabel: "5 GB",
    description: "Compact multimodal reasoning",
    maxContextLength: 131_072,
    contextLabel: "128K",
    minRamGb: 8,
    recommendedRamGb: 10,
    family: "gemma",
    supportsVision: true,
    mmprojUrl:
      "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/mmproj-F16.gguf",
    mmprojFilename: "mmproj-F16.gguf",
    mmprojFileSizeGb: 0.99,
  },
  {
    id: "gemma-4-26b-a4b",
    name: "Gemma 4 26B-A4B GGUF",
    filename: "gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf",
    huggingFaceUrl:
      "https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF/resolve/main/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf",
    fileSizeGb: 17.1,
    sizeLabel: "17.1 GB",
    description: "Fast MoE with 256K context",
    maxContextLength: 262_144,
    contextLabel: "256K",
    minRamGb: 20,
    recommendedRamGb: 24,
    family: "gemma",
    tag: "High Performance",
    supportsVision: true,
    mmprojUrl:
      "https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF/resolve/main/mmproj-F16.gguf",
    mmprojFilename: "mmproj-F16.gguf",
    mmprojFileSizeGb: 1.19,
  },
  {
    id: "gemma-4-31b",
    name: "Gemma 4 31B GGUF",
    filename: "gemma-4-31B-it-Q4_K_M.gguf",
    huggingFaceUrl:
      "https://huggingface.co/unsloth/gemma-4-31B-it-GGUF/resolve/main/gemma-4-31B-it-Q4_K_M.gguf",
    fileSizeGb: 19.0,
    sizeLabel: "19 GB",
    description: "Top-tier dense reasoning",
    maxContextLength: 262_144,
    contextLabel: "256K",
    minRamGb: 24,
    recommendedRamGb: 32,
    family: "gemma",
    tag: "High Performance",
    supportsVision: true,
    mmprojUrl:
      "https://huggingface.co/unsloth/gemma-4-31B-it-GGUF/resolve/main/mmproj-F16.gguf",
    mmprojFilename: "mmproj-F16.gguf",
    mmprojFileSizeGb: 1.20,
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
    tag: "New",
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
    tag: "New",
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
    chatTemplateAsset: "qwen3.5-chat-template.jinja",
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
    chatTemplateAsset: "qwen3.5-chat-template.jinja",
    tag: "High Performance",
    supportsVision: true,
    mmprojUrl:
      "https://huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF/resolve/main/mmproj-F16.gguf",
    mmprojFilename: "mmproj-F16.gguf",
    mmprojFileSizeGb: 0.90,
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
