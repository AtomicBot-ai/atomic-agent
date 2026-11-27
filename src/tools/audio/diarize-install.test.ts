import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installDiarizeEngine, installDiarizeModel, isUnusedTool, type DiarizeInstallDeps } from "./diarize-install.js";
import { DIARIZE_MODELS, diarizeAssetFor, diarizeDir, managedDiarizeBinary, managedDiarizeDir } from "./diarize-release.js";

let data: string;
beforeEach(() => { data = mkdtempSync(join(tmpdir(), "diarize-inst-")); });
afterEach(() => { rmSync(data, { recursive: true, force: true }); });

const asset = diarizeAssetFor("linux", "x64")!;
const signal = new AbortController().signal;

function fakeNet(o: { badHash?: boolean } = {}): DiarizeInstallDeps & { urls: string[] } {
  const urls: string[] = [];
  const digests = new Map<string, string>();
  return {
    urls,
    download: async (url, dest, opts) => {
      urls.push(url);
      writeFileSync(dest, "x");
      const model = DIARIZE_MODELS.find((m) => m.url === url);
      digests.set(dest, model ? model.sha256 : asset.sha256);
      opts.onProgress(1, 2);
    },
    hashFile: async (p) => (o.badHash ? "0".repeat(64) : digests.get(p) ?? ""),
    extract: async (_archive, dest) => {
      const root = join(dest, "sherpa-onnx-v1.13.8-linux-x64-shared");
      mkdirSync(join(root, "bin"), { recursive: true });
      mkdirSync(join(root, "lib"), { recursive: true });
      writeFileSync(join(root, "bin", "sherpa-onnx-offline-speaker-diarization"), "");
      writeFileSync(join(root, "bin", "sherpa-onnx-offline-tts"), "");
      writeFileSync(join(root, "lib", "libonnxruntime.so"), "");
    },
  };
}

describe("diarizer first-use download (ATO-2514)", () => {
  it("downloads, checks, unpacks into bin/ and lib/, and keeps only the diarizer", async () => {
    const net = fakeNet();
    const bin = await installDiarizeEngine(data, asset, "linux", { signal, deps: net });
    expect(bin).toBe(managedDiarizeBinary(data, "linux"));
    expect(existsSync(bin)).toBe(true);
    expect(existsSync(join(managedDiarizeDir(data), "lib", "libonnxruntime.so"))).toBe(true);
    expect(readdirSync(join(managedDiarizeDir(data), "bin"))).toEqual(["sherpa-onnx-offline-speaker-diarization"]);
    expect(net.urls).toEqual([`https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/${asset.name}`]);
    // The archive is gone, and a second call downloads nothing.
    expect(readdirSync(join(diarizeDir(data), "bin"))).toEqual(["v1.13.8"]);
    await installDiarizeEngine(data, asset, "linux", { signal, deps: net });
    expect(net.urls).toHaveLength(1);
  });

  it("throws a download away when its digest does not match, and installs nothing", async () => {
    await expect(installDiarizeEngine(data, asset, "linux", { signal, deps: fakeNet({ badHash: true }) })).rejects.toThrow(/SHA-256/);
    expect(existsSync(managedDiarizeBinary(data, "linux"))).toBe(false);
    await expect(installDiarizeModel(data, DIARIZE_MODELS[0]!, { signal, deps: fakeNet({ badHash: true }) })).rejects.toThrow(/SHA-256/);
    expect(readdirSync(diarizeDir(data)).filter((n) => n.endsWith(".onnx"))).toEqual([]);
  });

  it("renames a model into place only after the check", async () => {
    const seen: string[] = [];
    const net = fakeNet();
    const path = await installDiarizeModel(data, DIARIZE_MODELS[1]!, { signal, deps: net, onProgress: (p) => seen.push(p.item) });
    expect(path).toBe(join(diarizeDir(data), DIARIZE_MODELS[1]!.file));
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.download`)).toBe(false);
    expect(seen).toEqual(["embedding"]);
  });

  it("keeps the libraries and the Windows CLI, drops the other example tools", () => {
    expect(isUnusedTool("sherpa-onnx-offline-tts", "linux")).toBe(true);
    expect(isUnusedTool("sherpa-onnx-offline-speaker-diarization", "linux")).toBe(false);
    expect(isUnusedTool("sherpa-onnx-offline-speaker-diarization.exe", "win32")).toBe(false);
    expect(isUnusedTool("sherpa-onnx-c-api.dll", "win32")).toBe(false);
    expect(isUnusedTool("onnxruntime.dll", "win32")).toBe(false);
    expect(isUnusedTool("sherpa-onnx-keyword-spotter.exe", "win32")).toBe(true);
  });
});
