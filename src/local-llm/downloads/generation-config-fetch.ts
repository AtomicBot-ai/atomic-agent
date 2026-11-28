import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readGgufMetadata, type GgufValue } from "../catalog/gguf-metadata.js";
import {
  samplingFromGenerationConfig,
  samplingFromGgufKeys,
} from "../catalog/gguf-sampling.js";
import {
  fetchHuggingFaceBaseModels,
  fetchHuggingFaceGenerationConfig,
} from "../catalog/huggingface-api.js";
import { isHuggingFaceUrl } from "../catalog/huggingface-endpoint.js";
import {
  parseHuggingFaceModelRef,
  type HuggingFaceModelRef,
} from "../catalog/huggingface-ref.js";
import type { LocalModelDef } from "../catalog/models-catalog.js";

/**
 * After a GGUF download, put the authors' `generation_config.json` next
 * to it when the header names no `general.sampling.*` (ATO-2482), so
 * `gguf-sampling.ts` has the model's own temperature / top-p / top-k to
 * offer. Qwen3.5 2B / 4B / 9B and Muse Glimmer ship headers without
 * those keys. No GGUF repo in the catalog ships the file itself, so the
 * repo's card `base_model` is tried next, two hops deep
 * (unsloth/X-GGUF, then unsloth/X, then Qwen/X). Precedent: llama.cpp's
 * converter reads the same file into the header; LM Studio and Jan read
 * the same fields from the source repo.
 *
 * Best-effort and quiet: any failure leaves the download as it was.
 * Never runs for a model added from disk (`localPath`): nothing is
 * written next to the person's own files.
 */

export type GenerationConfigOutcome =
  | "skipped"
  | "header"
  | "present"
  | "saved"
  | "none";

export interface GenerationConfigDeps {
  readHeaderKeys?: (path: string) => Promise<Record<string, GgufValue>>;
  baseModels?: (repoId: string) => Promise<string[]>;
  fetchConfig?: (repoId: string, revision: string) => Promise<string | null>;
  writeText?: (path: string, text: string) => Promise<void>;
  exists?: (path: string) => boolean;
  signal?: AbortSignal;
}

const MAX_FETCHES = 4;

async function writeAtomically(path: string, text: string): Promise<void> {
  const tmp = `${path}.part`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

/** The repos to ask, nearest first, without repeats. */
async function candidateRepos(
  repoId: string,
  baseModels: (repoId: string) => Promise<string[]>,
): Promise<string[]> {
  const seen = [repoId];
  for (const parent of await baseModels(repoId)) {
    if (!seen.includes(parent)) seen.push(parent);
    for (const grand of await baseModels(parent)) {
      if (!seen.includes(grand)) seen.push(grand);
    }
  }
  return seen.slice(0, MAX_FETCHES);
}

export async function fetchGenerationConfigBeside(
  model: LocalModelDef,
  weightsPath: string,
  deps: GenerationConfigDeps = {},
): Promise<GenerationConfigOutcome> {
  if (model.localPath || !isHuggingFaceUrl(model.huggingFaceUrl)) return "skipped";
  const exists = deps.exists ?? existsSync;
  const target = join(dirname(weightsPath), "generation_config.json");
  if (exists(target)) return "present";
  const readHeaderKeys =
    deps.readHeaderKeys ?? (async (path) => (await readGgufMetadata(path)).keys);
  try {
    const fromHeader = samplingFromGgufKeys(await readHeaderKeys(weightsPath));
    if (Object.keys(fromHeader).length > 0) return "header";
  } catch {
    // Unreadable header: the JSON is the only source left.
  }
  let ref: HuggingFaceModelRef;
  try {
    ref = parseHuggingFaceModelRef(model.huggingFaceUrl);
  } catch {
    return "skipped";
  }
  const signal = deps.signal;
  const baseModels =
    deps.baseModels ?? ((id) => fetchHuggingFaceBaseModels(id, signal ? { signal } : {}));
  const fetchConfig =
    deps.fetchConfig ??
    ((id, rev) => fetchHuggingFaceGenerationConfig(id, rev, signal ? { signal } : {}));
  const repos = await candidateRepos(ref.repoId, baseModels);
  for (const repo of repos) {
    if (signal?.aborted) return "none";
    const text = await fetchConfig(repo, repo === ref.repoId ? ref.revision : "main");
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (Object.keys(samplingFromGenerationConfig(parsed)).length === 0) continue;
    try {
      await (deps.writeText ?? writeAtomically)(target, text);
      return "saved";
    } catch {
      return "none";
    }
  }
  return "none";
}
