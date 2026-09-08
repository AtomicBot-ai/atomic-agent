/**
 * The curated catalogue's METADATA, vendored.
 *
 * SOURCE OF TRUTH: `src/local-llm/models-catalog.ts` — `LOCAL_MODELS_CATALOG`.
 * Every field below is copied from there, verbatim, id for id. Nothing here
 * is estimated, rounded or reworded.
 *
 * Why a copy at all. `atag models list` prints
 * `ID | FAMILY | SIZE | CONTEXT | DL | ACTIVE` and has no `--json`, so the
 * description, the two RAM figures and the vision flag — the facts a person
 * actually chooses on — never cross the CLI boundary. The desktop has to run
 * against a RELEASED agent as well as against this checkout, so it cannot
 * import the module either (the shipped binary has no source tree). The copy
 * is the honest option: real numbers, one source named, and a smoke check
 * (`main.ts`, "the vendored catalogue metadata still matches `atag models
 * list`") that fails the moment the agent's catalogue and this table disagree
 * on which ids exist.
 *
 * DRIFT PROCEDURE: when that check goes red, diff this file against
 * `src/local-llm/models-catalog.ts` and copy the entries across. Never invent
 * a row to make the check pass — an id with no entry here simply renders
 * without a blurb, which is the designed behaviour for a model the desktop
 * does not know (every `custom-…` model added from Hugging Face is one).
 */

export interface CuratedModelMeta {
  /** Catalogue id, the join key against `atag models list`. */
  id: string;
  /** `name` — the catalogue's human title. */
  name: string;
  /** `description` — the one-line blurb the picker shows under the id. */
  description: string;
  /** `minRamGb` — below this the model does not run here at all. */
  minRamGb: number;
  /** `recommendedRamGb` — at or above this it runs comfortably. */
  recommendedRamGb: number;
  /** `fileSizeGb` — the weights download, in GB. */
  sizeGb: number;
  /** `contextLabel`. */
  contextLabel: string;
  /** `supportsVision` — it reads images (a projector rides along). */
  vision: boolean;
  /** `tag`, when the catalogue sets one. */
  tag?: string;
  /** `uncensored` — reduced-refusal weights; never auto-recommended. */
  uncensored?: boolean;
}

export const CURATED_MODEL_META: readonly CuratedModelMeta[] = [
  {
    id: "gemma-4-e4b",
    name: "Gemma 4 E4B QAT GGUF",
    description: "Compact multimodal reasoning (QAT)",
    minRamGb: 6,
    recommendedRamGb: 8,
    sizeGb: 4.22,
    contextLabel: "128K",
    vision: true,
  },
  {
    id: "gemma-4-12b",
    name: "Gemma 4 12B QAT GGUF",
    description: "Mid-size dense multimodal reasoning (QAT)",
    minRamGb: 8,
    recommendedRamGb: 12,
    sizeGb: 6.72,
    contextLabel: "256K",
    vision: true,
  },
  {
    id: "gemma-4-26b-a4b",
    name: "Gemma 4 26B-A4B QAT GGUF",
    description: "Fast MoE with 256K context (QAT)",
    minRamGb: 16,
    recommendedRamGb: 20,
    sizeGb: 14.25,
    contextLabel: "256K",
    vision: true,
    tag: "High Performance",
  },
  {
    id: "gemma-4-31b",
    name: "Gemma 4 31B QAT GGUF",
    description: "Top-tier dense reasoning (QAT)",
    minRamGb: 20,
    recommendedRamGb: 24,
    sizeGb: 17.29,
    contextLabel: "256K",
    vision: true,
    tag: "High Performance",
  },
  {
    id: "qwen-3.8-27b",
    name: "Qwen 3.8 27B GGUF",
    description: "Latest dense agentic reasoning",
    minRamGb: 20,
    recommendedRamGb: 28,
    sizeGb: 17.9,
    contextLabel: "256K",
    vision: true,
    tag: "New",
  },
  {
    id: "qwen-3.6-27b",
    name: "Qwen 3.6 27B GGUF",
    description: "Next-gen dense reasoning",
    minRamGb: 20,
    recommendedRamGb: 28,
    sizeGb: 17.6,
    contextLabel: "256K",
    vision: true,
  },
  {
    id: "qwen-3.6-35b-a3b",
    name: "Qwen 3.6 35B-A3B GGUF",
    description: "Next-gen agentic coding MoE",
    minRamGb: 24,
    recommendedRamGb: 36,
    sizeGb: 22.4,
    contextLabel: "256K",
    vision: true,
  },
  {
    id: "qwen-3.5-4b",
    name: "Qwen 3.5 4B GGUF",
    description: "Quality-size sweet spot",
    minRamGb: 6,
    recommendedRamGb: 8,
    sizeGb: 2.7,
    contextLabel: "256K",
    vision: true,
  },
  {
    id: "qwen-3.5-9b",
    name: "Qwen 3.5 9B GGUF",
    description: "Balanced performance",
    minRamGb: 10,
    recommendedRamGb: 16,
    sizeGb: 5.3,
    contextLabel: "256K",
    vision: true,
    tag: "Recommended",
  },
  {
    id: "qwen-3.5-35b",
    name: "Qwen 3.5 35B-A3B GGUF",
    description: "High quality reasoning",
    minRamGb: 24,
    recommendedRamGb: 36,
    sizeGb: 22.0,
    contextLabel: "256K",
    vision: true,
    tag: "High Performance",
  },
  {
    id: "nemotron-3.5-30b-a3b",
    name: "NVIDIA Nemotron 3.5 Lightning 30B-A3B GGUF",
    description: "Hybrid Mamba2 MoE reasoning, imatrix-calibrated",
    minRamGb: 24,
    recommendedRamGb: 32,
    sizeGb: 19.65,
    contextLabel: "256K",
    vision: false,
    tag: "New",
  },
  {
    id: "muse-glimmer-30b",
    name: "Meta Muse Glimmer 30B GGUF",
    description: "Multimodal 30B MoE, generic tool calling",
    minRamGb: 20,
    recommendedRamGb: 32,
    sizeGb: 15.9,
    contextLabel: "128K",
    vision: true,
    tag: "New",
  },
  {
    id: "qwen-3.8-27b-uncensored",
    name: "Qwen3.8 27B Uncensored GGUF",
    description: "Reduced-refusal Qwen3.8 27B (abliterated)",
    minRamGb: 20,
    recommendedRamGb: 32,
    sizeGb: 16.5,
    contextLabel: "256K",
    vision: true,
    tag: "Use at your own risk",
    uncensored: true,
  },
];

const BY_ID = new Map(CURATED_MODEL_META.map((m) => [m.id, m]));

/** The entry for a catalogue id, or null — an unknown id gets no blurb. */
export function curatedMeta(id: string): CuratedModelMeta | null {
  return BY_ID.get(id) ?? null;
}

/** Every id this table knows, for the smoke's drift check. */
export function curatedMetaIds(): string[] {
  return CURATED_MODEL_META.map((m) => m.id);
}
