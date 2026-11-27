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
  acquireModelsDirMoveLock,
  chatStartPending,
  getDaemonStatus,
  getEmbeddingDaemonStatus,
  getModelsDirOverride,
  isDownloadJobLive,
  listDownloadJobs,
  modelsDirUnreachableMessage,
  moveModelsDir,
  resolveModelsDir,
  unreachableModelsDir,
} from "../local-llm/index.js";

/**
 * `atomic-agent models dir [<path> | --reset] [--json]` (ATO-2106): where
 * the downloaded models live, and moving them somewhere else, such as an
 * external disk. Same shape as LM Studio's "Models Directory: Change",
 * which moves the files and then points the app at the new folder.
 *
 * ATO-2503: the move holds the models-move marker from before the busy
 * check to the config write, so no model start or download slips in
 * between (models-dir-move-lock.ts). A copy across disks prints
 * `copied <done> of <total> bytes (<model>)` lines; Ctrl+C or SIGTERM
 * stops it and puts every model back, and so does a "stop" line on stdin
 * with `--stop-on-stdin` (the desktop's Cancel, which works on Windows). A models folder whose disk is not
 * connected is said as such, never moved from (there is nothing to move),
 * and `--reset` then only points back at the default folder.
 */

export const MODELS_DIR_KEY = "localModels.managed.modelsDirOverride";

export interface ModelsDirDeps {
  write?: (text: string) => void;
  writeErr?: (text: string) => void;
  /** Why a move cannot start now (a model running, a download going), or null. */
  busyReason?: (dataDir: string) => Promise<string | null>;
  /** Test seam: stops the move as Ctrl+C would. Without it SIGINT and SIGTERM do. */
  signal?: AbortSignal;
  /** Test seam for `--stop-on-stdin`: the stream read for "stop" (default process.stdin). */
  stopInput?: NodeJS.ReadableStream;
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
  if (chatStartPending(dataDir)) {
    return "a local model is starting; wait for it, stop it (atomic-agent models stop), then try again";
  }
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

/** SIGINT and SIGTERM abort the move for as long as it runs; the undo removes the handlers. */
function abortOnSignals(controller: AbortController): () => void {
  const stop = (): void => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  };
}

/**
 * `--stop-on-stdin` (the desktop passes it): a "stop" line on stdin, or
 * stdin closing (the app quit), stops the move like Ctrl+C, so the
 * rollback runs. A signal cannot do that on Windows, where SIGTERM ends
 * the process at once. The undo stops reading.
 */
function abortOnStdinStop(controller: AbortController, input: NodeJS.ReadableStream): () => void {
  let seen = "";
  const onData = (chunk: Buffer | string): void => {
    seen = (seen + chunk.toString()).slice(-64);
    if (/(^|\n)stop\r?(\n|$)/.test(seen)) controller.abort();
  };
  const onEnd = (): void => controller.abort();
  input.on("data", onData);
  input.on("end", onEnd);
  input.resume();
  return () => {
    input.off("data", onData);
    input.off("end", onEnd);
    input.pause();
    if (input === process.stdin) process.stdin.destroy();
  };
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
  const stopOnStdin = args.includes("--stop-on-stdin");
  const reset = args.includes("--reset");
  const positional = args.filter((a) => !a.startsWith("--"));

  const cfg = getConfig();
  const dataDir = cfg.paths.localModelsDataDir;
  const current = resolveModelsDir(dataDir);
  const defaultDir = join(dataDir, "models");

  const unreachable = unreachableModelsDir();
  if (!reset && positional.length === 0) {
    // Same source as `current`: config.json re-read on change, not the cached
    // config, so a long-lived TUI never says "default" next to a moved folder.
    const custom = getModelsDirOverride() !== null;
    const reachable = unreachable === null;
    write(json ? `${JSON.stringify({ dir: current, defaultDir, custom, reachable })}\n` : `${current}\n`);
    if (!json && !reachable) writeErr(`models dir: ${modelsDirUnreachableMessage(current)}\n`);
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
  if (unreachable !== null && !reset) {
    writeErr(`models dir: ${modelsDirUnreachableMessage(unreachable)}\n`);
    return 1;
  }

  let release: () => void;
  try {
    release = acquireModelsDirMoveLock(dataDir);
  } catch (err) {
    writeErr(`models dir: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const controller = new AbortController();
  const stopSignals = deps.signal ? () => {} : abortOnSignals(controller);
  const stopStdin = stopOnStdin ? abortOnStdinStop(controller, deps.stopInput ?? process.stdin) : () => {};
  const stopListening = (): void => {
    stopSignals();
    stopStdin();
  };
  const signal = deps.signal ? AbortSignal.any([deps.signal, controller.signal]) : controller.signal;
  try {
    // Checked while holding the marker: a start or a download that begins
    // after this line meets the marker and refuses.
    const busy = await (deps.busyReason ?? defaultBusyReason)(dataDir);
    if (busy) {
      writeErr(`models dir: ${busy}\n`);
      return 1;
    }
    if (unreachable !== null) {
      // --reset with the disk unplugged: nothing can move, only the folder setting goes.
      saveOverride(cfg.paths.userConfigFile, null);
      if (json) write(`${JSON.stringify({ dir: defaultDir, moved: [], skipped: [], leftovers: [], leftOn: unreachable })}\n`);
      else write(`the models on ${unreachable} stay there; connect that disk to move them back later\nmodels folder: ${defaultDir}\n`);
      return 0;
    }
    const result = await moveModelsDir(current, target, {
      signal,
      onProgress: (p) => {
        if (!json) write(`moving ${p.entry} (${p.index}/${p.total})\n`);
      },
      onBytes: (b) => {
        if (!json) write(`copied ${b.done} of ${b.total} bytes (${b.entry})\n`);
      },
      commit: () => saveOverride(cfg.paths.userConfigFile, reset ? null : target),
    });
    if (json) {
      write(`${JSON.stringify({ dir: target, moved: result.moved, skipped: result.skipped, leftovers: result.leftovers })}\n`);
    } else {
      if (result.skipped.length > 0) write(`left in place (not model folders): ${result.skipped.join(", ")}\n`);
      for (const left of result.leftovers) write(`could not delete the old copy at ${left}; delete it by hand\n`);
      write(`models folder: ${target}\n`);
    }
    return 0;
  } catch (err) {
    writeErr(`models dir: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    stopListening();
    release();
  }
}
