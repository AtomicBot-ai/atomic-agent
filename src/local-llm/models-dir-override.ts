import { existsSync, statSync } from "node:fs";

/**
 * The folder the downloaded models live in when the operator moved them
 * out of `<dataDir>/models` (ATO-2106), for example onto an external disk.
 *
 * Pushed in by `loadConfig` from `localModels.managed.modelsDirOverride`,
 * the same way the backend variant and the download fan-out reach this
 * config-free layer (`setConfiguredBackendVariant`,
 * `setDefaultDownloadConnections`). `null` means the default folder.
 *
 * ATO-2503: a long-lived process (the desktop's `serve` sidecar, the TUI)
 * loads the config once, so a move another process made (`atomic-agent
 * models dir`, the desktop card) went unseen until a restart: new pulls
 * landed in the old folder and moved models read as not downloaded. With
 * a `source` the value follows the config file: each read compares the
 * file's mtime and size with the last ones and, when they changed, reads
 * the key again (`source.read`, owned by the config layer). Same idea as
 * Ollama reading `OLLAMA_MODELS` per request instead of once.
 */
export interface ModelsDirOverrideSource {
  /** The config file the override comes from. */
  file: string;
  /** The override that file names now, absolute, or null. Throwing keeps the last value. */
  read: () => string | null;
}

let modelsDirOverride: string | null = null;
let source: ModelsDirOverrideSource | null = null;
let stamp: string | null = null;

function fileStamp(file: string): string {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

export function setModelsDirOverride(dir: string | null, from: ModelsDirOverrideSource | null = null): void {
  modelsDirOverride = dir;
  source = from;
  stamp = from ? fileStamp(from.file) : null;
}

export function getModelsDirOverride(): string | null {
  if (source) {
    const now = fileStamp(source.file);
    if (now !== stamp) {
      stamp = now;
      try {
        modelsDirOverride = source.read();
      } catch {
        /* a half-written or broken file: keep the folder we had */
      }
    }
  }
  return modelsDirOverride;
}

/**
 * The override folder when it is set but not there: its disk is not
 * connected (an unplugged USB drive, an unmounted network share), or the
 * folder was deleted by hand. `null` when the models use the default
 * folder or the override folder exists. Callers say so instead of
 * reporting every model as not downloaded (ATO-2503).
 */
export function unreachableModelsDir(): string | null {
  const dir = getModelsDirOverride();
  return dir !== null && !existsSync(dir) ? dir : null;
}

/** The words for an unreachable models folder, shared by every refusal. */
export function modelsDirUnreachableMessage(dir: string): string {
  return `the models folder ${dir} is not there (is its disk connected?); connect it and try again, or run atomic-agent models dir --reset to go back to the default folder`;
}
