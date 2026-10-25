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
  /** `mmprojFileSizeGb` — the projector a vision model's pull also fetches. */
  mmprojSizeGb?: number;
  /** `supportsVision` — it reads images (a projector rides along). */
  vision: boolean;
  /** `recommendRank` — recommendation order, 1 first; unset = never auto-recommended. */
  recommendRank?: number;
  /** `tag`, when the catalogue sets one. */
  tag?: string;
  /** `uncensored` — reduced-refusal weights; never auto-recommended. */
  uncensored?: boolean;
}

export const CURATED_MODEL_META: readonly CuratedModelMeta[] = [
  {
    id: "gemma-4-e4b",
    name: "Gemma 4 E4B QAT GGUF",
    description: "Small and light Gemma, for 8 GB machines and up",
    recommendRank: 10,
    minRamGb: 6,
    recommendedRamGb: 8,
    sizeGb: 4.22,
    mmprojSizeGb: 0.99,
    contextLabel: "128K",
    vision: true,
  },
  {
    id: "gemma-4-12b",
    name: "Gemma 4 12B QAT GGUF",
    description: "Mid-size Gemma, for 12 GB machines and up",
    recommendRank: 9,
    minRamGb: 8,
    recommendedRamGb: 12,
    sizeGb: 6.72,
    mmprojSizeGb: 0.175,
    contextLabel: "256K",
    vision: true,
  },
  {
    id: "gemma-4-26b-a4b",
    name: "Gemma 4 26B-A4B QAT GGUF",
    description: "Big Gemma that stays quick for its size, 20 GB and up",
    recommendRank: 2,
    minRamGb: 16,
    recommendedRamGb: 20,
    sizeGb: 14.25,
    mmprojSizeGb: 1.19,
    contextLabel: "256K",
    vision: true,
    tag: "High Performance",
  },
  {
    id: "gemma-4-31b",
    name: "Gemma 4 31B QAT GGUF",
    description: "Biggest Gemma, slower than the 26B, for 24 GB and up",
    recommendRank: 6,
    minRamGb: 20,
    recommendedRamGb: 24,
    sizeGb: 17.29,
    mmprojSizeGb: 1.2,
    contextLabel: "256K",
    vision: true,
    tag: "High Performance",
  },
  {
    id: "qwen-3.8-27b",
    name: "Qwen 3.8 27B GGUF",
    description: "Newest big Qwen, for 28 GB machines and up",
    recommendRank: 4,
    minRamGb: 20,
    recommendedRamGb: 28,
    sizeGb: 17.9,
    mmprojSizeGb: 0.93,
    contextLabel: "256K",
    vision: true,
    tag: "New",
  },
  {
    id: "qwen-3.6-27b",
    name: "Qwen 3.6 27B GGUF",
    description: "Big Qwen, older version, for 28 GB machines and up",
    recommendRank: 5,
    minRamGb: 20,
    recommendedRamGb: 28,
    sizeGb: 17.6,
    mmprojSizeGb: 0.93,
    contextLabel: "256K",
    vision: true,
  },
  {
    id: "qwen-3.6-35b-a3b",
    name: "Qwen 3.6 35B-A3B GGUF",
    description: "Big Qwen that stays quick for its size, 36 GB and up",
    recommendRank: 1,
    minRamGb: 24,
    recommendedRamGb: 36,
    sizeGb: 22.4,
    mmprojSizeGb: 0.9,
    contextLabel: "256K",
    vision: true,
  },
  {
    id: "qwen-3.5-4b",
    name: "Qwen 3.5 4B GGUF",
    description: "Small and quick to download, for 8 GB machines and up",
    recommendRank: 8,
    minRamGb: 6,
    recommendedRamGb: 8,
    sizeGb: 2.7,
    mmprojSizeGb: 0.67,
    contextLabel: "256K",
    vision: true,
  },
  {
    id: "qwen-3.5-9b",
    name: "Qwen 3.5 9B GGUF",
    description: "Everyday mid-size Qwen, for 16 GB machines and up",
    recommendRank: 7,
    minRamGb: 10,
    recommendedRamGb: 16,
    sizeGb: 5.3,
    mmprojSizeGb: 0.92,
    contextLabel: "256K",
    vision: true,
  },
  {
    id: "qwen-3.5-35b",
    name: "Qwen 3.5 35B-A3B GGUF",
    description: "Older big Qwen, quick for its size, 36 GB and up",
    recommendRank: 3,
    minRamGb: 24,
    recommendedRamGb: 36,
    sizeGb: 22.0,
    mmprojSizeGb: 0.9,
    contextLabel: "256K",
    vision: true,
    tag: "High Performance",
  },
  {
    id: "nemotron-3.5-30b-a3b",
    name: "NVIDIA Nemotron 3.5 Lightning 30B-A3B GGUF",
    description: "Big NVIDIA model, quick for its size, text only, 32 GB and up",
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
    description: "Big Meta model, generic tool calling, 32 GB and up",
    minRamGb: 20,
    recommendedRamGb: 32,
    sizeGb: 15.9,
    mmprojSizeGb: 2.05,
    contextLabel: "128K",
    vision: true,
    tag: "New",
  },
  {
    id: "qwen-3.8-27b-uncensored",
    name: "Qwen 3.8 27B Uncensored GGUF",
    description: "Reduced-refusal Qwen 3.8 27B (abliterated)",
    minRamGb: 20,
    recommendedRamGb: 32,
    sizeGb: 16.5,
    mmprojSizeGb: 0.93,
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
