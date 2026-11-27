import { join } from "node:path";

/**
 * Speaker diarization (ATO-2514): who spoke when, on this computer, with
 * sherpa-onnx (Apache-2.0, k2-fsa/sherpa-onnx). Nothing here is bundled:
 * `atomic-agent diarize install` downloads the pinned build and two small
 * models on first use, each checked against its published SHA-256.
 *
 * The engine is upstream's prebuilt `sherpa-onnx-offline-speaker-diarization`
 * CLI from release v1.13.8 (September 2026), the "shared" archives: the CLI
 * plus onnxruntime and sherpa-onnx as libraries beside it. Windows uses the
 * MT (static C runtime) build so no Visual C++ redistributable is needed.
 *
 * Models (about 35 MB together, see DIARIZE_MODELS):
 *   - segmentation: pyannote segmentation-3.0 exported to ONNX by the
 *     sherpa-onnx authors (MIT, like pyannote's own model), 6.0 MB;
 *   - speaker embedding: 3D-Speaker CAM++ trained on VoxCeleb
 *     (Apache-2.0), 29.6 MB.
 */
export const DIARIZE_RELEASE = {
  tag: "v1.13.8",
  repo: "k2-fsa/sherpa-onnx",
} as const;

export const DIARIZE_BINARY = "sherpa-onnx-offline-speaker-diarization";

export interface DiarizeAsset {
  name: string;
  sizeBytes: number;
  sha256: string;
}

const ASSETS: Readonly<Record<string, DiarizeAsset>> = {
  "darwin-arm64": {
    name: "sherpa-onnx-v1.13.8-osx-arm64-shared.tar.bz2",
    sizeBytes: 20_314_448,
    sha256: "b10e5c7e2c30ea03de9c442655d14860d9edc475c6251d58a8f5f06e913a1d56",
  },
  "darwin-x64": {
    name: "sherpa-onnx-v1.13.8-osx-x64-shared.tar.bz2",
    sizeBytes: 22_846_038,
    sha256: "54aad64acee9d2d596535a6080d6f22602a720af5460e1d50461b1e1b06bee40",
  },
  "win32-x64": {
    name: "sherpa-onnx-v1.13.8-win-x64-shared-MT-Release.tar.bz2",
    sizeBytes: 24_805_859,
    sha256: "6dffdc715a4465b989446a6105265d2cb345e7101591a17d35534b6758f6e8df",
  },
  "win32-arm64": {
    name: "sherpa-onnx-v1.13.8-win-arm64-shared-MT-Release.tar.bz2",
    sizeBytes: 23_341_583,
    sha256: "455ea18dc44aea188b4f7976037dea3d77e3f8d7afe0760f34244a7a0db53c4c",
  },
  "linux-x64": {
    name: "sherpa-onnx-v1.13.8-linux-x64-shared.tar.bz2",
    sizeBytes: 28_156_791,
    sha256: "c0bdb7907d3a74bba1d55d22bf4d9fa75586cf1530614ebe88a27b9118e015c4",
  },
  "linux-arm64": {
    name: "sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu.tar.bz2",
    sizeBytes: 28_091_778,
    sha256: "4e3734f82bc1379fd91f219f5869c7e9d03b7a4f7561907d8abca4849c51a789",
  },
};

export type DiarizeModelRole = "segmentation" | "embedding";

export interface DiarizeModel {
  role: DiarizeModelRole;
  /** The name it is saved under in `<models dir>/diarize/`. */
  file: string;
  url: string;
  sizeBytes: number;
  sha256: string;
  license: string;
}

export const DIARIZE_MODELS: readonly DiarizeModel[] = [
  {
    role: "segmentation",
    file: "pyannote-segmentation-3-0.onnx",
    // Pinned to the Hugging Face commit, so the file cannot change under the digest.
    url: "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/9403a6902bb58e3d5ae8c7e77c3422de279db2e0/model.onnx",
    sizeBytes: 5_992_913,
    sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
    license: "MIT",
  },
  {
    role: "embedding",
    file: "3dspeaker-campplus-en-voxceleb-16k.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
    sizeBytes: 29_596_979,
    sha256: "98daf9bcf1c8abf3db374fec4c27a5eda7c58705bb3f180d057b085a72a88bb5",
    license: "Apache-2.0",
  },
];

/** The prebuilt for this machine, or null where upstream ships none. */
export function diarizeAssetFor(platform: NodeJS.Platform, arch: string): DiarizeAsset | null {
  return ASSETS[`${platform}-${arch}`] ?? null;
}

export function diarizeAssetUrl(asset: DiarizeAsset): string {
  return `https://github.com/${DIARIZE_RELEASE.repo}/releases/download/${DIARIZE_RELEASE.tag}/${asset.name}`;
}

/** `<models dir>/diarize`: the models, and the engine under `bin/<tag>`. */
export function diarizeDir(localModelsDataDir: string): string {
  return join(localModelsDataDir, "diarize");
}

/** `<models dir>/diarize/bin/<tag>`: the unpacked release (its `bin/` and `lib/`). */
export function managedDiarizeDir(localModelsDataDir: string): string {
  return join(diarizeDir(localModelsDataDir), "bin", DIARIZE_RELEASE.tag);
}

export function managedDiarizeBinary(localModelsDataDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(managedDiarizeDir(localModelsDataDir), "bin", platform === "win32" ? `${DIARIZE_BINARY}.exe` : DIARIZE_BINARY);
}

export function diarizeModelPath(localModelsDataDir: string, model: DiarizeModel): string {
  return join(diarizeDir(localModelsDataDir), model.file);
}

export function diarizeModel(role: DiarizeModelRole): DiarizeModel {
  return DIARIZE_MODELS.find((m) => m.role === role)!;
}

/** Everything a first use downloads on this machine, in bytes (0 where there is no build). */
export function diarizeDownloadBytes(platform: NodeJS.Platform, arch: string): number {
  const asset = diarizeAssetFor(platform, arch);
  if (!asset) return 0;
  return asset.sizeBytes + DIARIZE_MODELS.reduce((n, m) => n + m.sizeBytes, 0);
}
