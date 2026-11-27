import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { getConfig, parseUserConfigFile, resetConfigCache } from "../config/index.js";
import {
  deleteConfigPath,
  readRawConfigTree,
  writeConfigPath,
  writeRawUserConfigFileSync,
} from "../config/config-paths.js";
import {
  getDaemonStatus,
  getEmbeddingDaemonStatus,
  isDownloadJobLive,
  listDownloadJobs,
  moveModelsDir,
  resolveModelsDir,
} from "../local-llm/index.js";

/**
 * `atomic-agent models dir [<path> | --reset] [--json]` (ATO-2106): where
 * the downloaded models live, and moving them somewhere else, such as an
 * external disk. Same shape as LM Studio's "Models Directory: Change",
 * which moves the files and then points the app at the new folder.
 */

export const MODELS_DIR_KEY = "localModels.managed.modelsDirOverride";

export interface ModelsDirDeps {
  write?: (text: string) => void;
  writeErr?: (text: string) => void;
  /** Why a move cannot start now (a model running, a download going), or null. */
  busyReason?: (dataDir: string) => Promise<string | null>;
}

/** `~` is the home directory; a relative path is taken from the current one. */
export function expandModelsDirArg(raw: string): string {
  const value = raw.trim();
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

async function defaultBusyReason(dataDir: string): Promise<string | null> {
  const cfg = getConfig();
  if (listDownloadJobs(dataDir).some(isDownloadJobLive)) {
    return "a model download is running; pause or cancel it first (atomic-agent models downloads)";
  }
  const chat = await getDaemonStatus(dataDir, cfg.localModels.managed.port).catch(() => null);
  const embedding = await getEmbeddingDaemonStatus(dataDir, cfg.localModels.embeddings.port).catch(() => null);
  if (chat?.running || embedding?.running) {
    return "a local model is running; stop it first (atomic-agent models stop)";
  }
  return null;
}

function saveOverride(configPath: string, dir: string | null): void {
  const tree = readRawConfigTree(configPath);
  if (dir === null) deleteConfigPath(tree, MODELS_DIR_KEY);
  else writeConfigPath(tree, MODELS_DIR_KEY, dir);
  // Validate first, write second, as `config set` does.
  parseUserConfigFile(tree);
  writeRawUserConfigFileSync(configPath, tree);
  resetConfigCache();
}

export async function runModelsDir(args: readonly string[], deps: ModelsDirDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => void process.stdout.write(t));
  const writeErr = deps.writeErr ?? ((t: string) => void process.stderr.write(t));
  const json = args.includes("--json");
  const reset = args.includes("--reset");
  const positional = args.filter((a) => !a.startsWith("--"));

  const cfg = getConfig();
  const dataDir = cfg.paths.localModelsDataDir;
  const current = resolveModelsDir(dataDir);
  const defaultDir = join(dataDir, "models");

  if (!reset && positional.length === 0) {
    const custom = cfg.localModels.managed.modelsDirOverride !== undefined;
    write(json ? `${JSON.stringify({ dir: current, defaultDir, custom })}\n` : `${current}\n`);
    return 0;
  }
  if (reset && positional.length > 0) {
    writeErr("models dir: give a folder or --reset, not both\n");
    return 2;
  }
  if (positional.length > 1) {
    writeErr("models dir: give one folder (quote a path with spaces)\n");
    return 2;
  }

  const target = reset ? defaultDir : expandModelsDirArg(positional[0]!);
  const busy = await (deps.busyReason ?? defaultBusyReason)(dataDir);
  if (busy) {
    writeErr(`models dir: ${busy}\n`);
    return 1;
  }

  try {
    const result = await moveModelsDir(current, target, {
      onProgress: (p) => {
        if (!json) write(`moving ${p.entry} (${p.index}/${p.total})\n`);
      },
      commit: () => saveOverride(cfg.paths.userConfigFile, reset ? null : target),
    });
    if (json) {
      write(`${JSON.stringify({ dir: target, moved: result.moved, leftovers: result.leftovers })}\n`);
    } else {
      for (const left of result.leftovers) write(`could not delete the old copy at ${left}; delete it by hand\n`);
      write(`models folder: ${target}\n`);
    }
    return 0;
  } catch (err) {
    writeErr(`models dir: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
