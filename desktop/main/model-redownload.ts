/**
 * ATO-1745: "Download model again" for a model file the server found damaged
 * (engine-failure.ts `reason: model_file_corrupt`). The agent's downloader
 * counts a model as done when its weights file exists
 * (src/local-llm/downloads/model-installer.ts downloadModel: `existsSync(dest)`),
 * so a damaged file left in place would make the pull a no-op. This deletes the
 * weights in the app's own models folder first; the pull that follows is the
 * usual one (main.ts startModelPull, the same as Settings › Models' Download).
 *
 * Only `<modelsDir>/<id>/` is touched, never a model added from disk (its file
 * lives where the person keeps it). A projector is kept: it was not what failed.
 */

import { readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { isPartialDownloadFile } from "./download-pause.js";
import { isMmprojFile } from "./huggingface.js";

/** A model's weights in its folder: a `.gguf` that is not a projector, or a partial download of one. */
export function isWeightsFile(name: string): boolean {
  if (isMmprojFile(name)) return false;
  if (/\.gguf$/i.test(name)) return true;
  return isPartialDownloadFile(name) && /\.gguf\.part(\.json)?$/i.test(name) && !/^mmproj/i.test(name);
}

/**
 * Delete the weights in `<modelsDir>/<id>/`. Returns the names that could not
 * be deleted (a file the system still holds open): empty when the folder is
 * clear, or when there was nothing there. An id that is not one folder name
 * deletes nothing.
 */
export function removeDamagedWeights(modelsDir: string, id: string): string[] {
  if (!id || id === "." || id === ".." || basename(id) !== id) return [];
  const dir = join(modelsDir, id);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const left: string[] = [];
  for (const name of names) {
    if (!isWeightsFile(name)) continue;
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      left.push(name);
    }
  }
  return left;
}
