import { listLocalModels, type LocalModelDef } from "./models-catalog.js";

/** The last path segment, for `/` and `\` alike (a Windows server's path). */
export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * The catalog entry whose weights file is the one a server reports
 * (`/props.model_path`, ATO-2482), matched by file name so the managed
 * daemon, an External llama-server started on a downloaded file and a
 * model added from disk all resolve. Case-insensitive, since Windows and
 * macOS file systems are. When two entries share a file name, the last
 * wins: the person's own added entry comes after the curated rows.
 */
export function findLocalModelForFile(
  modelPath: string,
  models: readonly LocalModelDef[] = listLocalModels(),
): LocalModelDef | undefined {
  const wanted = fileNameOf(modelPath).toLowerCase();
  if (wanted === "") return undefined;
  let found: LocalModelDef | undefined;
  for (const def of models) {
    const own = fileNameOf(def.localPath ?? def.filename).toLowerCase();
    if (own === wanted) found = def;
  }
  return found;
}
