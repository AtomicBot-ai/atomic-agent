import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tool-registry.js";
import { buildAudioTranscribeTool, type AudioTranscribeToolOptions } from "./transcribe.js";
import type { RunProcess } from "./run-process.js";
import type { InstallDeps } from "./whisper-install.js";
import { whisperModelById } from "./whisper-models.js";
import { managedWhisperBinary, whisperAssetFor } from "./whisper-release.js";

let work: string;
let data: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "transcribe-work-"));
  data = mkdtempSync(join(tmpdir(), "transcribe-data-"));
  writeFileSync(join(work, "voice.ogg"), Buffer.from("OggS"));
  writeFileSync(join(work, "clip.wav"), Buffer.from("RIFF"));
  writeFileSync(join(work, "notes.txt"), "not audio");
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

const ctx = (): ToolContext => ({ workingDir: work, sessionId: "s1", stepIndex: 0, signal: new AbortController().signal });
const MODEL = () => join(data, "whisper", "ggml-base.bin");

/**
 * A fake network: `download` writes a placeholder file and records the
 * URL; `hashFile` answers the published digest for whatever URL wrote
 * the file (or `badHash`); `extract` lays out the release folder.
 */
function fakeInstall(opts: { badHash?: boolean } = {}) {
  const urls: string[] = [];
  const shaByDest = new Map<string, string>();
  const deps: InstallDeps = {
    download: vi.fn(async (url: string, dest: string, o: { onProgress: (t: number, total: number) => void }) => {
      urls.push(url);
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, "x");
      const model = ["tiny", "base", "small", "medium", "large-v3-turbo"].map((id) => whisperModelById(id)!).find((m) => url.endsWith(m.file));
      const asset = whisperAssetFor("linux", "x64")!;
      const size = model?.sizeBytes ?? asset.sizeBytes;
      o.onProgress(size / 2, size);
      o.onProgress(size, size);
      shaByDest.set(dest, model?.sha256 ?? asset.sha256);
    }),
    hashFile: async (path: string) => (opts.badHash ? "0".repeat(64) : shaByDest.get(path) ?? ""),
    extract: async (_archive: string, _format: string, destDir: string) => {
      mkdirSync(join(destDir, "whisper-bin-ubuntu-x64"), { recursive: true });
      writeFileSync(join(destDir, "whisper-bin-ubuntu-x64", "whisper-cli"), "#!/bin/sh\n");
      writeFileSync(join(destDir, "whisper-bin-ubuntu-x64", "libwhisper.so.1"), "");
    },
  };
  return { deps, urls };
}

function tool(over: {
  binaries?: string[];
  modelOnDisk?: boolean;
  run?: RunProcess;
  platform?: NodeJS.Platform;
  install?: InstallDeps;
} = {}) {
  const binaries = over.binaries ?? ["/bin/whisper-cli", "/bin/ffmpeg"];
  const platform = over.platform ?? "darwin";
  const request = vi.fn(async () => ({ approved: true }));
  const progress: Array<{ fraction: number; label: string }> = [];
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const run: RunProcess = over.run ?? (async (cmd, args) => {
    calls.push({ cmd, args });
    return cmd.endsWith("whisper-cli") ? { code: 0, stdout: " Привет, это тест.\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
  });
  const installed = fakeInstall();
  const install = over.install ?? installed.deps;
  const built = buildAudioTranscribeTool({
    approvals: { request } as never,
    approvalRequired: true,
    dataDir: () => data,
    platform,
    arch: "x64",
    // A downloaded binary counts as executable once it is on disk.
    binaryLookup: { env: { PATH: "/bin" }, platform, widenEnv: (e) => e, isExecutable: (p) => binaries.includes(p) || (p.startsWith(data) && existsSync(p)) },
    modelLookup: { env: {}, fileExists: (p) => (p === MODEL() && (over.modelOnDisk ?? true)) || (p.startsWith(data) && existsSync(p)) },
    run,
    install,
    onProgress: (_sid, u) => progress.push({ fraction: u.fraction, label: u.label }),
  });
  return { built, request, calls, urls: installed.urls, progress };
}

describe("audio.transcribe (ATO-702)", () => {
  it("converts a voice message with ffmpeg, runs whisper-cli and returns the text", async () => {
    const { built, calls, request } = tool();
    const result = await built.run({ path: "voice.ogg", language: "ru" }, ctx());
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("Привет, это тест.");
    expect(calls.map((c) => c.cmd)).toEqual(["/bin/ffmpeg", "/bin/whisper-cli"]);
    expect(calls[0]!.args).toContain(join(work, "voice.ogg"));
    expect(calls[1]!.args).toEqual(expect.arrayContaining(["-m", MODEL(), "-l", "ru", "-nt"]));
    expect(request).not.toHaveBeenCalled();
  });

  it("says how to install whisper.cpp when it is missing", async () => {
    const { built } = tool({ binaries: ["/bin/ffmpeg"] });
    const result = await built.run({ path: "voice.ogg" }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("brew install whisper-cpp");
  });

  it("needs ffmpeg for a voice message, not for a WAV", async () => {
    const { built, calls } = tool({ binaries: ["/bin/whisper-cli"] });
    const ogg = await built.run({ path: "voice.ogg" }, ctx());
    expect(ogg.status).toBe("error");
    expect(ogg.summary).toContain("brew install ffmpeg");
    const wav = await built.run({ path: "clip.wav" }, ctx());
    expect(wav.status).toBe("ok");
    expect(calls.map((c) => c.cmd)).toEqual(["/bin/whisper-cli"]);
  });

  it("downloads a missing model on first use after one approval, with progress, then runs", async () => {
    const { built, request, urls, progress, calls } = tool({ modelOnDisk: false });
    const result = await built.run({ path: "voice.ogg" }, ctx());
    expect(result.status).toBe("ok");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "audio.transcribe", category: "http", affectedResources: ["huggingface.co"], reason: expect.stringContaining("148 MB") }),
      expect.anything(),
    );
    expect(urls).toEqual(["https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"]);
    expect(existsSync(MODEL())).toBe(true);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)!.fraction).toBe(1);
    expect(calls.at(-1)!.args).toEqual(expect.arrayContaining(["-m", MODEL()]));
  });

  it("on Linux with nothing installed fetches the upstream whisper.cpp build and the model, then runs", async () => {
    const { built, request, urls, progress, calls } = tool({ platform: "linux", binaries: ["/bin/ffmpeg"], modelOnDisk: false });
    const result = await built.run({ path: "voice.ogg" }, ctx());
    expect(result.status).toBe("ok");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ affectedResources: ["github.com", "huggingface.co"] }),
      expect.anything(),
    );
    expect(urls).toEqual([
      "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-x64.tar.gz",
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    ]);
    const bin = managedWhisperBinary(data, "linux");
    expect(existsSync(bin)).toBe(true);
    expect(calls.at(-1)!.cmd).toBe(bin);
    const fractions = progress.map((p) => p.fraction);
    expect(fractions).toEqual([...fractions].sort((x, y) => x - y));
    expect(progress.some((p) => p.label.includes("whisper.cpp"))).toBe(true);
    expect(progress.some((p) => p.label.includes("base"))).toBe(true);
  });

  it("fetches small when the saved default is small", async () => {
    const { built, urls, calls } = tool({ modelOnDisk: false });
    mkdirSync(join(data, "whisper"), { recursive: true });
    writeFileSync(join(data, "whisper", "settings.json"), JSON.stringify({ defaultModel: "small" }));
    const result = await built.run({ path: "voice.ogg" }, ctx());
    expect(result.status).toBe("ok");
    expect(urls).toEqual(["https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"]);
    expect(calls.at(-1)!.args).toEqual(expect.arrayContaining(["-m", join(data, "whisper", "ggml-small.bin")]));
  });

  it("make_default saves the model for later calls", async () => {
    const { built, urls } = tool({ modelOnDisk: false });
    await built.run({ path: "voice.ogg", model: "small", make_default: true }, ctx());
    expect(JSON.parse(readFileSync(join(data, "whisper", "settings.json"), "utf8"))).toEqual({ defaultModel: "small" });
    expect(urls).toEqual(["https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"]);
    expect((await built.run({ path: "voice.ogg", make_default: true }, ctx())).status).toBe("error");
  });

  it("throws away a download whose SHA-256 does not match", async () => {
    const bad = fakeInstall({ badHash: true });
    const { built } = tool({ modelOnDisk: false, install: bad.deps });
    const result = await built.run({ path: "voice.ogg" }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("SHA-256");
    expect(existsSync(MODEL())).toBe(false);
    expect(existsSync(`${MODEL()}.download`)).toBe(false);
  });

  it("on macOS a missing whisper.cpp is the brew line, nothing is downloaded", async () => {
    const { built, request, urls } = tool({ binaries: ["/bin/ffmpeg"], modelOnDisk: false });
    const result = await built.run({ path: "voice.ogg" }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("brew install whisper-cpp");
    expect(request).not.toHaveBeenCalled();
    expect(urls).toEqual([]);
  });

  it("refuses a file that is not audio or does not exist", async () => {
    const { built } = tool();
    expect((await built.run({ path: "notes.txt" }, ctx())).summary).toContain("does not look like an audio file");
    expect((await built.run({ path: "gone.ogg" }, ctx())).summary).toContain("file not found");
    expect((await built.run({}, ctx())).status).toBe("error");
    expect((await built.run({ path: "voice.ogg", language: "-m /etc/passwd" }, ctx())).status).toBe("error");
  });

  it("returns a long transcript whole, not cut to the default summary size", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} of a long voice note.`).join("\n");
    const { built } = tool({
      run: async (cmd) => (cmd.endsWith("whisper-cli") ? { code: 0, stdout: long, stderr: "" } : { code: 0, stdout: "", stderr: "" }),
    });
    const result = await built.run({ path: "voice.ogg" }, ctx());
    expect(result.summary).toContain("Sentence number 0 ");
    expect(result.summary).toContain("Sentence number 59 ");
  });

  it("reports whisper.cpp's own error", async () => {
    const { built } = tool({
      run: async (cmd) => (cmd.endsWith("whisper-cli") ? { code: 3, stdout: "", stderr: "failed to load model" } : { code: 0, stdout: "", stderr: "" }),
    });
    const result = await built.run({ path: "voice.ogg" }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("failed to load model");
  });
});
