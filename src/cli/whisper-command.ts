import { existsSync } from "node:fs";
import { getConfig } from "../config/index.js";
import { resolveWhisperBinary, type BinaryLookupOptions } from "../tools/audio/whisper-binary.js";
import { installWhisperBinary, installWhisperModel, type InstallDeps } from "../tools/audio/whisper-install.js";
import {
  readDefaultWhisperModel,
  resolveWhisperModel,
  whisperModelById,
  WHISPER_MODELS,
  whisperModelPath,
  writeDefaultWhisperModel,
} from "../tools/audio/whisper-models.js";
import { managedWhisperBinary, WHISPER_RELEASE, whisperAssetFor } from "../tools/audio/whisper-release.js";

/**
 * `atomic-agent whisper status|install|default` (ATO-702, decision 75):
 * the speech-to-text pieces `audio.transcribe` and the desktop's
 * dictation use, from one place. `install` fetches what is missing (the
 * pinned whisper.cpp build on Windows/Linux, the speech model) through
 * the same verified download the tool uses; `--json` prints one JSON
 * object per line so the desktop can draw the progress. Running it is
 * the user's go-ahead (the desktop runs it when the user turns dictation
 * on), so it does not ask again.
 */
const HELP = [
  "Usage: atomic-agent whisper <status|install|default> [options]",
  "",
  "  status [--json]                 What is installed: whisper.cpp, the speech models, the default",
  "  install [--model <id>] [--json] Download what is missing (whisper.cpp on Windows/Linux, the model)",
  "  default <id>                    Save the default speech model",
  "",
  `Models: ${WHISPER_MODELS.map((m) => m.id).join(", ")} (default base).`,
  "On macOS whisper.cpp comes from `brew install whisper-cpp`.",
].join("\n");

export interface WhisperCommandDeps {
  write?: (text: string) => void;
  dataDir?: () => string;
  platform?: NodeJS.Platform;
  arch?: string;
  install?: InstallDeps;
  signal?: AbortSignal;
  /** Test seam for the PATH lookup. */
  binaryLookup?: BinaryLookupOptions;
}

export async function whisperCommand(args: string[], deps: WhisperCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const [sub, ...rest] = args;
  if (!sub || sub === "-h" || sub === "--help") {
    write(`${HELP}\n`);
    return sub ? 0 : 2;
  }
  const dataDir = (deps.dataDir ?? (() => getConfig().paths.localModelsDataDir))();
  const binaryStatus = () => resolveWhisperBinary({ ...deps.binaryLookup, platform }, managedWhisperBinary(dataDir, platform));
  const json = rest.includes("--json");
  const out = (obj: Record<string, unknown>, text: string) => write(json ? `${JSON.stringify(obj)}\n` : `${text}\n`);

  if (sub === "default") {
    const id = rest.find((a) => !a.startsWith("--"));
    if (!id || !whisperModelById(id)) {
      write(`default needs a model id: ${WHISPER_MODELS.map((m) => m.id).join(", ")}\n`);
      return 2;
    }
    writeDefaultWhisperModel(dataDir, id);
    out({ type: "default", model: id }, `Default speech model: ${id}`);
    return 0;
  }

  if (sub === "status") {
    const bin = binaryStatus();
    const defaultModel = readDefaultWhisperModel(dataDir);
    const models = WHISPER_MODELS.map((m) => ({ id: m.id, sizeMb: m.sizeMb, installed: existsSync(whisperModelPath(dataDir, m)) }));
    const report = {
      type: "status",
      binary: bin.found ? { found: true, path: bin.path, source: bin.source } : { found: false, reason: bin.reason },
      downloadable: whisperAssetFor(platform, arch) !== null,
      release: WHISPER_RELEASE.tag,
      defaultModel,
      models,
    };
    out(report, [
      `whisper.cpp: ${bin.found ? `${bin.path} (${bin.source})` : bin.reason}`,
      `default model: ${defaultModel}`,
      ...models.map((m) => `  ${m.id.padEnd(15)} ${m.installed ? "installed" : `${m.sizeMb} MB, not downloaded`}`),
    ].join("\n"));
    return 0;
  }

  if (sub !== "install") {
    write(`unknown whisper command "${sub}"\n\n${HELP}\n`);
    return 2;
  }

  let requested: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--json") continue;
    if (a === "--model" || a.startsWith("--model=")) {
      requested = a === "--model" ? rest[++i] : a.slice(8);
      if (!requested || !whisperModelById(requested)) {
        write(`--model must be one of: ${WHISPER_MODELS.map((m) => m.id).join(", ")}\n`);
        return 2;
      }
      continue;
    }
    write(`unknown option "${a}"\n\n${HELP}\n`);
    return 2;
  }

  const controller = new AbortController();
  deps.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const onSignal = (): void => controller.abort();
  const own = deps.signal === undefined;
  if (own) {
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }
  try {
    let bin = binaryStatus();
    const asset = bin.found ? null : whisperAssetFor(platform, arch);
    if (!bin.found && asset === null) {
      out({ type: "error", code: "whisper-missing", message: bin.reason }, bin.reason);
      return 1;
    }
    // A model id given here is not saved as the default: `default` does that.
    const model = resolveWhisperModel(dataDir, requested, { env: {} });
    if (model.kind === "error") {
      out({ type: "error", code: "model", message: model.reason }, model.reason);
      return 1;
    }
    const fetchModel = model.kind === "download" ? model.model : null;
    const total = (asset?.sizeBytes ?? 0) + (fetchModel?.sizeBytes ?? 0);
    let doneBytes = 0;
    let last = -1;
    const progress = (item: string, transferred: number) => {
      const fraction = total > 0 ? Math.min(1, (doneBytes + transferred) / total) : 1;
      if (fraction - last < 0.01 && fraction < 1) return;
      last = fraction;
      out({ type: "progress", item, fraction }, `${item}: ${Math.round(fraction * 100)}%`);
    };
    if (asset !== null) {
      const path = await installWhisperBinary(dataDir, asset, platform, {
        signal: controller.signal, deps: deps.install, onProgress: (p) => progress("engine", p.transferred),
      });
      doneBytes += asset.sizeBytes;
      bin = { found: true, path, source: "managed" };
    }
    if (fetchModel !== null) {
      await installWhisperModel(dataDir, fetchModel, {
        signal: controller.signal, deps: deps.install, onProgress: (p) => progress("model", p.transferred),
      });
      doneBytes += fetchModel.sizeBytes;
    }
    const modelId = model.kind === "download" ? model.model.id : model.label;
    out(
      { type: "done", binary: bin.found ? bin.path : null, model: modelId, modelPath: model.path },
      `Ready: whisper.cpp ${bin.found ? bin.path : ""}, model ${modelId}`,
    );
    return 0;
  } catch (err) {
    const message = (err as Error).message;
    out({ type: "error", code: controller.signal.aborted ? "cancelled" : "download", message }, `Download failed: ${message}`);
    return 1;
  } finally {
    if (own) {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    }
  }
}
