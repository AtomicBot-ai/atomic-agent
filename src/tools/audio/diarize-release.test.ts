import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  DIARIZE_MODELS,
  diarizeAssetFor,
  diarizeAssetUrl,
  diarizeDownloadBytes,
  managedDiarizeBinary,
} from "./diarize-release.js";

describe("pinned sherpa-onnx diarizer (ATO-2514)", () => {
  const targets: Array<[NodeJS.Platform, string]> = [
    ["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"], ["win32", "arm64"], ["linux", "x64"], ["linux", "arm64"],
  ];

  it("has a build with a SHA-256 for every desktop target, from one release", () => {
    for (const [p, a] of targets) {
      const asset = diarizeAssetFor(p, a)!;
      expect(asset, `${p}-${a}`).toBeTruthy();
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.name).toMatch(/^sherpa-onnx-v1\.13\.8-.*shared.*\.tar\.bz2$/);
      expect(diarizeAssetUrl(asset)).toBe(`https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/${asset.name}`);
    }
    expect(diarizeAssetFor("freebsd", "x64")).toBeNull();
  });

  it("pins both models with size, digest and license, the Hugging Face one by commit", () => {
    expect(DIARIZE_MODELS.map((m) => m.role)).toEqual(["segmentation", "embedding"]);
    for (const m of DIARIZE_MODELS) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.sizeBytes).toBeGreaterThan(1_000_000);
      expect(["MIT", "Apache-2.0"]).toContain(m.license);
    }
    expect(DIARIZE_MODELS[0]!.url).toMatch(/\/resolve\/[0-9a-f]{40}\/model\.onnx$/);
  });

  it("says how much a first use downloads, and where the CLI lands", () => {
    expect(diarizeDownloadBytes("darwin", "arm64")).toBe(20_314_448 + 5_992_913 + 29_596_979);
    expect(diarizeDownloadBytes("freebsd", "x64")).toBe(0);
    expect(managedDiarizeBinary("/m", "win32")).toBe(join("/m", "diarize", "bin", "v1.13.8", "bin", "sherpa-onnx-offline-speaker-diarization.exe"));
  });
});
