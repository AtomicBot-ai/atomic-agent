import { getConfig } from "../config/index.js";
import {
  downloadJobId,
  getDaemonStatus,
  getLocalModelDef,
  isDownloadJobLive,
  isKnownLocalModelId,
  isMmprojDownloaded,
  isModelDownloaded,
  readDownloadJob,
  removeDownloadJob,
} from "../local-llm/index.js";
import {
  positionalArgs,
  runLocalModelsPull,
  runLocalModelsStart,
  runLocalModelsStop,
  runLocalModelsUse,
} from "./models-handlers.js";

/**
 * `models pull <id> --run`: download, make active, start. The terminal
 * twin of what the TUI does after a finished pull. A step that fails
 * ends the command with that step's exit code.
 *
 * A projector that could not be fetched does not stop it, as in the
 * TUI: the pull has already said why vision is off, and the model comes
 * up text-only because `start` keys on the projector file.
 */
export async function runLocalModelsPullAndRun(args: string[]): Promise<number> {
  if (args.includes("--background")) {
    process.stderr.write(
      "--run starts the model when the download ends here, so it cannot be combined with --background\n",
    );
    return 2;
  }
  const pullArgs = args.filter((a) => a !== "--run");
  const idArg = positionalArgs(pullArgs)[0];
  // The pull itself reports an unknown id.
  if (!idArg || !isKnownLocalModelId(idArg)) return runLocalModelsPull(pullArgs);
  const m = getLocalModelDef(idArg);
  if (m.supportsVision && !pullArgs.includes("--mmproj")) pullArgs.push("--mmproj");

  const dataDir = getConfig().paths.localModelsDataDir;
  const jobId = downloadJobId("chat", m.id);
  // A running worker is followed as it is, so one started without the
  // projector will not fetch it.
  const before = readDownloadJob(dataDir, jobId);
  const fetchProjectorAfter =
    m.supportsVision && isDownloadJobLive(before) && before.mode === "gguf-only";

  const pulled = await runLocalModelsPull(pullArgs);
  if (pulled !== 0) return pulled;
  // Ctrl+C while following a worker detaches and exits 0.
  if (isDownloadJobLive(readDownloadJob(dataDir, jobId))) {
    process.stderr.write(
      `${m.id} is still downloading in the background, so it was not started; run this command again when it finishes\n`,
    );
    return 1;
  }
  if (!isModelDownloaded(dataDir, m)) {
    process.stderr.write(`${m.id}: the model file is not on disk, so it was not started\n`);
    return 1;
  }
  if (fetchProjectorAfter && !isMmprojDownloaded(dataDir, m)) {
    const projector = await runLocalModelsPull(pullArgs);
    if (projector !== 0) return projector;
  }

  // `start` refuses while a chat model runs. Stopped before `use`, so
  // `use` does not tell the operator to restart it by hand.
  const status = await getDaemonStatus(dataDir, getConfig().localModels.managed.port);
  if (status.running) {
    process.stdout.write(`restarting the local model with ${m.id}\n`);
    const stopped = await runLocalModelsStop({ chatOnly: true });
    if (stopped !== 0) return stopped;
  }
  const used = await runLocalModelsUse(m.id);
  if (used !== 0) return used;
  // Left behind (finished, or an interrupted one this pull completed), the
  // next TUI launch would land this model all over again.
  const finishedJob = readDownloadJob(dataDir, jobId);
  if (finishedJob && !isDownloadJobLive(finishedJob)) removeDownloadJob(dataDir, jobId);
  return startCancellable();
}

/** Ctrl+C reaches `start` on Atomic Core, as in `models start`. */
async function startCancellable(): Promise<number> {
  if (getConfig().localModels.managed.engine !== "atomic-core") return runLocalModelsStart();
  const cancel = new AbortController();
  const onSignal = (): void => cancel.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await runLocalModelsStart({ signal: cancel.signal });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
