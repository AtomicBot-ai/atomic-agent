/**
 * Reference in, downloadable choices out. One call the first-run screen
 * can await: it parses what was typed, asks Hugging Face what is in the
 * repo, and either returns the GGUFs worth offering or throws a sentence
 * the screen can print as-is.
 */

import {
  listHuggingFaceGgufFiles,
  type HuggingFaceFile,
} from "./huggingface-api.js";
import {
  describeRejectedGgufFiles,
  isMmprojFile,
  judgeGgufFile,
  type GgufVerdict,
} from "./huggingface-fit.js";
import { formatGgufSize, ggufSizeGb } from "./huggingface-model-def.js";
import { parseHuggingFaceModelRef } from "./huggingface-ref.js";

/** One servable GGUF, in the shape the picker draws. */
export interface HuggingFaceGgufChoice {
  path: string;
  filename: string;
  sizeBytes: number;
  fileSizeGb: number;
  sizeLabel: string;
}

export interface HuggingFaceRepoChoices {
  repoId: string;
  revision: string;
  /** Smallest first: the one most likely to run here leads the list. */
  choices: readonly HuggingFaceGgufChoice[];
  /** The projector to pull alongside, when the repo ships one. */
  mmproj: HuggingFaceFile | null;
  /** One line naming what was filtered out, or `null` when nothing was. */
  hidden: string | null;
}

/** Best-known quants first; anything unrecognised sorts by size after them. */
const QUANT_PREFERENCE = ["q4_k_xl", "q4_k_m", "q4_k_s", "q4_0", "q5_k_m", "q8_0"];

function quantRank(path: string): number {
  const lower = path.toLowerCase();
  const index = QUANT_PREFERENCE.findIndex((quant) => lower.includes(quant));
  return index === -1 ? QUANT_PREFERENCE.length : index;
}

function toChoice(file: HuggingFaceFile): HuggingFaceGgufChoice {
  return {
    path: file.path,
    filename: file.path.split("/").pop() ?? file.path,
    sizeBytes: file.sizeBytes,
    fileSizeGb: ggufSizeGb(file.sizeBytes),
    sizeLabel: formatGgufSize(file.sizeBytes),
  };
}

function pickMmproj(files: readonly HuggingFaceFile[]): HuggingFaceFile | null {
  const projectors = files.filter((file) => isMmprojFile(file.path));
  if (projectors.length === 0) return null;
  return [...projectors].sort((a, b) => a.sizeBytes - b.sizeBytes)[0]!;
}

/**
 * Resolve a pasted reference into the files worth offering.
 *
 * A reference that names one file collapses to a single choice — or to a
 * refusal quoting why that file cannot be served, which is more useful
 * than silently substituting a different one.
 */
export async function resolveHuggingFaceGgufChoices(
  reference: string,
): Promise<HuggingFaceRepoChoices> {
  const ref = parseHuggingFaceModelRef(reference);
  const files = await listHuggingFaceGgufFiles(ref.repoId, ref.revision);
  if (files.length === 0) {
    throw new Error(
      `No .gguf files in ${ref.repoId} — that is the original model, not a ` +
        `GGUF conversion of it. Look for a "-GGUF" repo of the same name.`,
    );
  }
  const mmproj = pickMmproj(files);

  if (ref.filePath) {
    const named = files.find((file) => file.path === ref.filePath);
    if (!named) {
      throw new Error(`${ref.filePath} is not in ${ref.repoId} @ ${ref.revision}.`);
    }
    const judgement = judgeGgufFile(named.path);
    if (judgement.verdict !== "usable") {
      throw new Error(`Cannot use ${named.path}: ${judgement.reason}`);
    }
    return {
      repoId: ref.repoId,
      revision: ref.revision,
      choices: [toChoice(named)],
      mmproj,
      hidden: null,
    };
  }

  const usable: HuggingFaceFile[] = [];
  const rejected: GgufVerdict[] = [];
  for (const file of files) {
    const { verdict } = judgeGgufFile(file.path);
    if (verdict === "usable") usable.push(file);
    else rejected.push(verdict);
  }
  if (usable.length === 0) {
    throw new Error(
      `${ref.repoId} has ${files.length} GGUF file${files.length === 1 ? "" : "s"} but ` +
        `none this agent can serve (${describeRejectedGgufFiles(rejected) ?? "unknown"}).`,
    );
  }
  const choices = usable
    .sort((a, b) => quantRank(a.path) - quantRank(b.path) || a.sizeBytes - b.sizeBytes)
    .map(toChoice);
  return {
    repoId: ref.repoId,
    revision: ref.revision,
    choices,
    mmproj,
    hidden: describeRejectedGgufFiles(rejected),
  };
}
