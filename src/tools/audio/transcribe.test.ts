import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tool-registry.js";
import { buildAudioTranscribeTool, type AudioTranscribeToolOptions } from "./transcribe.js";
import type { RunProcess } from "./run-process.js";

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

function tool(over: {
  binaries?: string[];
  modelOnDisk?: boolean;
  run?: RunProcess;
  download?: AudioTranscribeToolOptions["download"];
} = {}) {
  const binaries = over.binaries ?? ["/bin/whisper-cli", "/bin/ffmpeg"];
  const request = vi.fn(async () => ({ approved: true }));
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const run: RunProcess = over.run ?? (async (cmd, args) => {
    calls.push({ cmd, args });
    return cmd.endsWith("whisper-cli") ? { code: 0, stdout: " Привет, это тест.\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
  });
  const download = over.download ?? vi.fn(async () => undefined);
  const built = buildAudioTranscribeTool({
    approvals: { request } as never,
    approvalRequired: true,
    dataDir: () => data,
    binaryLookup: { env: { PATH: "/bin" }, platform: "darwin", widenEnv: (e) => e, isExecutable: (p) => binaries.includes(p) },
    modelLookup: { env: {}, fileExists: (p) => (over.modelOnDisk ?? true) && p === MODEL() },
    run,
    download,
  });
  return { built, request, calls, download };
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

  it("does not download the model unasked: it answers with the size first", async () => {
    const { built, request, download } = tool({ modelOnDisk: false });
    const result = await built.run({ path: "voice.ogg" }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("142 MB");
    expect(result.summary).toContain('"download": true');
    expect(result.details).toMatchObject({ needsDownload: true, model: "base" });
    expect(request).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("asks for approval with the size and host, then downloads from Hugging Face", async () => {
    const { built, request, download } = tool({ modelOnDisk: false });
    const result = await built.run({ path: "voice.ogg", download: true }, ctx());
    expect(result.status).toBe("ok");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "audio.transcribe", category: "http", affectedResources: ["huggingface.co"], reason: expect.stringContaining("142 MB") }),
      expect.anything(),
    );
    expect(download).toHaveBeenCalledWith(
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
      MODEL(),
      expect.anything(),
    );
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
