/**
 * Assemble a `LocalModelDef` for a model nobody curated. Ported from
 * PR #38 by sachin-detrax; the id slug and the RAM estimates are its
 * work, kept because the rest of the local-LLM stack already consumes
 * that shape and needs no second one.
 */

import { resolveHuggingFaceFileUrl, type HuggingFaceFile } from "./huggingface-api.js";
import type { LocalModelDef, LocalModelId } from "./models-catalog.js";

const BYTES_PER_GB = 1024 * 1024 * 1024;

/**
 * A filesystem-safe id for a user-added model. `<dataDir>/models/<id>/`
 * is created verbatim from this, so the character filter has to survive
 * Windows path rules as well as POSIX ones.
 */
export function buildCustomModelId(repoId: string, filePath: string): LocalModelId {
  const base = filePath.split("/").pop()!.replace(/\.gguf$/i, "");
  const slug = `${repoId}-${base}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return `custom-${slug.slice(0, 80)}`;
}

export function formatGgufSize(bytes: number): string {
  if (bytes <= 0) return "unknown";
  const gb = bytes / BYTES_PER_GB;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function ggufSizeGb(bytes: number): number {
  return bytes / BYTES_PER_GB;
}

/**
 * The curated catalog hand-writes a context window and a RAM envelope
 * per model. Neither is exposed by the Hugging Face API without reading
 * the GGUF header, so both are estimated: RAM as weights × 1.2 (minimum)
 * and × 1.5 + 2 GB (recommended), and `maxContextLength: 0` hands the
 * context decision to `resolveEffectiveContextSize`, which fits it to the
 * device. Both numbers are advisory everywhere they are read.
 */
export function buildCustomModelDef(input: {
  repoId: string;
  revision: string;
  file: HuggingFaceFile;
  mmproj: HuggingFaceFile | null;
}): LocalModelDef {
  const { repoId, revision, file, mmproj } = input;
  const fileSizeGb = ggufSizeGb(file.sizeBytes);
  const filename = file.path.split("/").pop()!;
  const base: LocalModelDef = {
    id: buildCustomModelId(repoId, file.path),
    name: `${repoId} · ${filename}`,
    filename,
    huggingFaceUrl: resolveHuggingFaceFileUrl(repoId, revision, file.path),
    fileSizeGb,
    sizeLabel: formatGgufSize(file.sizeBytes),
    description: `Added from huggingface.co/${repoId}`,
    maxContextLength: 0,
    contextLabel: "auto",
    minRamGb: Math.max(1, Math.ceil(fileSizeGb * 1.2)),
    recommendedRamGb: Math.max(2, Math.ceil(fileSizeGb * 1.5) + 2),
    family: "custom",
    supportsVision: mmproj !== null,
  };
  if (!mmproj) return base;
  return {
    ...base,
    mmprojUrl: resolveHuggingFaceFileUrl(repoId, revision, mmproj.path),
    mmprojFilename: mmproj.path.split("/").pop()!,
    mmprojFileSizeGb: ggufSizeGb(mmproj.sizeBytes),
  };
}
