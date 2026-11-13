import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installWhisperBinary, installWhisperModel, sha256File, type InstallDeps } from "./whisper-install.js";
import { whisperModelById, whisperModelPath } from "./whisper-models.js";
import { managedWhisperBinary, managedWhisperDir, whisperAssetFor, whisperAssetUrl } from "./whisper-release.js";

let data: string;
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "whisper-install-"));
});
afterEach(() => {
  rmSync(data, { recursive: true, force: true });
});

const signal = () => new AbortController().signal;

function deps(over: Partial<InstallDeps> & { sha?: string } = {}): InstallDeps & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    download: async (url, dest, o) => {
      urls.push(url);
      writeFileSync(dest, "payload");
      o.onProgress(7, 7);
    },
    hashFile: async () => over.sha ?? "",
    extract: async (_archive, _format, destDir) => {
      mkdirSync(join(destDir, "whisper-bin-ubuntu-x64"), { recursive: true });
      writeFileSync(join(destDir, "whisper-bin-ubuntu-x64", "whisper-cli"), "#!/bin/sh\n");
      writeFileSync(join(destDir, "whisper-bin-ubuntu-x64", "libwhisper.so.1.8.4"), "");
    },
    ...over,
  };
}

describe("whisper.cpp release pins (ATO-702)", () => {
  it("has upstream builds for Windows and Linux only, no macOS CLI", () => {
    expect(whisperAssetFor("win32", "x64")?.name).toBe("whisper-bin-x64.zip");
    expect(whisperAssetFor("win32", "arm64")?.name).toBe("whisper-bin-win-cpu-arm64.zip");
    expect(whisperAssetFor("linux", "x64")?.name).toBe("whisper-bin-ubuntu-x64.tar.gz");
    expect(whisperAssetFor("linux", "arm64")?.name).toBe("whisper-bin-ubuntu-arm64.tar.gz");
    expect(whisperAssetFor("darwin", "arm64")).toBeNull();
    expect(whisperAssetFor("darwin", "x64")).toBeNull();
    expect(whisperAssetUrl(whisperAssetFor("linux", "x64")!)).toBe(
      "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-x64.tar.gz",
    );
    expect(managedWhisperBinary("/m", "win32")).toBe(join("/m", "whisper", "bin", "b5454", "whisper-cli.exe"));
  });
});

describe("installWhisperBinary", () => {
  it("downloads, checks the digest, unpacks into the pinned folder and marks it executable", async () => {
    const asset = whisperAssetFor("linux", "x64")!;
    const d = deps({ sha: asset.sha256 });
    const seen: number[] = [];
    const bin = await installWhisperBinary(data, asset, "linux", { signal: signal(), deps: d, onProgress: (p) => seen.push(p.transferred) });
    expect(bin).toBe(managedWhisperBinary(data, "linux"));
    expect(existsSync(bin)).toBe(true);
    expect(existsSync(join(managedWhisperDir(data), "libwhisper.so.1.8.4"))).toBe(true);
    if (process.platform !== "win32") expect(statSync(bin).mode & 0o111).not.toBe(0);
    expect(d.urls).toEqual([whisperAssetUrl(asset)]);
    expect(seen).toEqual([7]);
    // The archive and the staging folder are gone.
    expect(readdirSync(join(data, "whisper", "bin"))).toEqual(["b5454"]);
    // Installed already: nothing is fetched again.
    await installWhisperBinary(data, asset, "linux", { signal: signal(), deps: d });
    expect(d.urls).toHaveLength(1);
  });

  it("refuses an archive whose digest does not match and leaves nothing behind", async () => {
    const asset = whisperAssetFor("linux", "x64")!;
    await expect(installWhisperBinary(data, asset, "linux", { signal: signal(), deps: deps({ sha: "0".repeat(64) }) }))
      .rejects.toThrow(/SHA-256/);
    expect(existsSync(managedWhisperBinary(data, "linux"))).toBe(false);
    expect(readdirSync(join(data, "whisper", "bin"))).toEqual([]);
  });

  it("fails when the archive has no CLI", async () => {
    const asset = whisperAssetFor("linux", "x64")!;
    const d = deps({ sha: asset.sha256, extract: async () => undefined });
    await expect(installWhisperBinary(data, asset, "linux", { signal: signal(), deps: d })).rejects.toThrow(/whisper-cli was not in/);
  });
});

describe("installWhisperModel", () => {
  it("renames the file into place only after the digest matched", async () => {
    const model = whisperModelById("small")!;
    const d = deps({ sha: model.sha256 });
    const path = await installWhisperModel(data, model, { signal: signal(), deps: d });
    expect(path).toBe(whisperModelPath(data, model));
    expect(existsSync(path)).toBe(true);
    expect(d.urls).toEqual(["https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"]);
  });

  it("deletes a model whose digest does not match", async () => {
    const model = whisperModelById("base")!;
    await expect(installWhisperModel(data, model, { signal: signal(), deps: deps({ sha: "f".repeat(64) }) })).rejects.toThrow(/SHA-256/);
    expect(existsSync(whisperModelPath(data, model))).toBe(false);
    expect(existsSync(`${whisperModelPath(data, model)}.download`)).toBe(false);
  });
});

describe("sha256File", () => {
  it("hashes a file as sha256sum does", async () => {
    const f = join(data, "a.bin");
    writeFileSync(f, "hello whisper");
    expect(await sha256File(f)).toBe(createHash("sha256").update("hello whisper").digest("hex"));
  });
});
