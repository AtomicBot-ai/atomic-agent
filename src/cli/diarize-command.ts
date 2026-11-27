import { existsSync, statSync } from "node:fs";
import { getConfig } from "../config/index.js";
import {
  installDiarizeEngine,
  installDiarizeModel,
  removeDiarize,
  type DiarizeInstallDeps,
} from "../tools/audio/diarize-install.js";
import {
  DIARIZE_MODELS,
  DIARIZE_RELEASE,
  diarizeAssetFor,
  diarizeDownloadBytes,
  diarizeModel,
  diarizeModelPath,
  managedDiarizeBinary,
} from "../tools/audio/diarize-release.js";
import { runDiarize, type DiarizeRunResult } from "../tools/audio/diarize-run.js";

/**
 * `atomic-agent diarize status|install|run|remove` (ATO-2514): who spoke
 * when in a recording, on this computer, with sherpa-onnx. `install` is the
 * first-use download (the pinned build and two models, about 55 to 65 MB,
 * see diarize-release.ts); the desktop runs it when the person turns
 * "Tell speakers apart" on or records a meeting with it on, so running it
 * is the go-ahead and it does not ask again. `run` reads a 16 kHz mono WAV
 * and prints the speaker turns. `--json` prints one JSON object per line.
 */
const HELP = [
  "Usage: atomic-agent diarize <status|install|run|remove> [options]",
  "",
  "  status [--json]                       What is installed, and the download size",
  "  install [--json]                      Download the sherpa-onnx diarizer and its two models",
  "  run <file.wav> [--speakers N] [--json] Who spoke when (16 kHz mono WAV)",
  "  remove [--json]                       Delete the diarizer and its models",
  "",
  `Engine: sherpa-onnx ${DIARIZE_RELEASE.tag} (Apache-2.0). Models: ${DIARIZE_MODELS.map((m) => `${m.file} (${m.license})`).join(", ")}.`,
].join("\n");

export interface DiarizeCommandDeps {
  write?: (text: string) => void;
  dataDir?: () => string;
  platform?: NodeJS.Platform;
  arch?: string;
  install?: DiarizeInstallDeps;
  signal?: AbortSignal;
  run?: typeof runDiarize;
}

/** Installed means the CLI is there and both models have their full size. */
export function diarizeInstalled(dataDir: string, platform: NodeJS.Platform): boolean {
  if (!existsSync(managedDiarizeBinary(dataDir, platform))) return false;
  return DIARIZE_MODELS.every((m) => {
    try { return statSync(diarizeModelPath(dataDir, m)).size === m.sizeBytes; } catch { return false; }
  });
}

function option(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

export async function diarizeCommand(args: string[], deps: DiarizeCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const [sub, ...rest] = args;
  if (!sub || sub === "-h" || sub === "--help") {
    write(`${HELP}\n`);
    return sub ? 0 : 2;
  }
  const dataDir = (deps.dataDir ?? (() => getConfig().paths.localModelsDataDir))();
  const json = rest.includes("--json");
  const out = (obj: Record<string, unknown>, text: string) => write(json ? `${JSON.stringify(obj)}\n` : `${text}\n`);
  const supported = diarizeAssetFor(platform, arch) !== null;

  if (sub === "status") {
    const installed = diarizeInstalled(dataDir, platform);
    const bytes = diarizeDownloadBytes(platform, arch);
    out(
      { type: "status", installed, supported, downloadBytes: bytes, release: DIARIZE_RELEASE.tag, models: DIARIZE_MODELS.map((m) => ({ file: m.file, license: m.license, sizeBytes: m.sizeBytes })) },
      !supported ? `Speaker diarization has no prebuilt engine for ${platform}-${arch}.`
        : installed ? `Speaker diarization is installed (sherpa-onnx ${DIARIZE_RELEASE.tag}).`
          : `Not installed. \`atomic-agent diarize install\` downloads ${Math.round(bytes / 1e6)} MB.`,
    );
    return 0;
  }

  if (sub === "remove") {
    await removeDiarize(dataDir);
    out({ type: "removed" }, "Speaker diarization removed.");
    return 0;
  }

  const controller = new AbortController();
  async function install(): Promise<number> {
    const asset = diarizeAssetFor(platform, arch);
    if (!asset) {
      out({ type: "error", code: "unsupported", message: `no prebuilt diarizer for ${platform}-${arch}` }, `No prebuilt diarizer for ${platform}-${arch}.`);
      return 1;
    }
    const total = diarizeDownloadBytes(platform, arch);
    let doneBytes = 0;
    let last = -1;
    const progress = (item: string, transferred: number) => {
      const fraction = total > 0 ? Math.min(1, (doneBytes + transferred) / total) : 1;
      if (fraction - last < 0.01 && fraction < 1) return;
      last = fraction;
      out({ type: "progress", item, fraction, totalBytes: total }, `${item}: ${Math.round(fraction * 100)}%`);
    };
    try {
      const opts = { signal: controller.signal, deps: deps.install, onProgress: (p: { item: string; transferred: number }) => progress(p.item, p.transferred) };
      const binary = await installDiarizeEngine(dataDir, asset, platform, opts);
      doneBytes += asset.sizeBytes;
      for (const m of DIARIZE_MODELS) {
        await installDiarizeModel(dataDir, m, opts);
        doneBytes += m.sizeBytes;
      }
      out({ type: "done", binary }, `Ready: ${binary}`);
      return 0;
    } catch (err) {
      const message = (err as Error).message;
      out({ type: "error", code: controller.signal.aborted ? "cancelled" : "download", message }, `Download failed: ${message}`);
      return 1;
    }
  }

  async function run(): Promise<number> {
    const wav = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--speakers");
    if (!wav) { write(`run needs a WAV file\n\n${HELP}\n`); return 2; }
    const n = option(rest, "--speakers");
    const speakers = n === undefined ? undefined : Number(n);
    if (speakers !== undefined && !(Number.isInteger(speakers) && speakers > 0 && speakers <= 20)) {
      write("--speakers must be a whole number from 1 to 20\n");
      return 2;
    }
    if (!diarizeInstalled(dataDir, platform)) {
      out({ type: "error", code: "not-installed", message: "run `atomic-agent diarize install` first" }, "Not installed: run `atomic-agent diarize install` first.");
      return 1;
    }
    const res: DiarizeRunResult = await (deps.run ?? runDiarize)(managedDiarizeBinary(dataDir, platform), {
      segmentation: diarizeModelPath(dataDir, diarizeModel("segmentation")),
      embedding: diarizeModelPath(dataDir, diarizeModel("embedding")),
      wav,
      ...(speakers !== undefined ? { speakers } : {}),
    }, { signal: controller.signal, platform, onProgress: (fraction) => { if (json) out({ type: "progress", fraction }, ""); } });
    if (!res.ok) {
      out({ type: "error", code: controller.signal.aborted ? "cancelled" : "run", message: res.error ?? "failed" }, `Diarization failed: ${res.error ?? "failed"}`);
      return 1;
    }
    out(
      { type: "done", spans: res.spans, speakers: new Set(res.spans.map((s) => s.speaker)).size },
      res.spans.map((s) => `${s.start.toFixed(2)} -- ${s.end.toFixed(2)} speaker ${s.speaker + 1}`).join("\n") || "(no speech found)",
    );
    return 0;
  }

  deps.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const onSignal = (): void => controller.abort();
  const own = deps.signal === undefined;
  if (own) { process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal); }
  try {
    if (sub === "install") return await install();
    if (sub === "run") return await run();
    write(`unknown diarize command "${sub}"\n\n${HELP}\n`);
    return 2;
  } finally {
    if (own) { process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal); }
  }
}
