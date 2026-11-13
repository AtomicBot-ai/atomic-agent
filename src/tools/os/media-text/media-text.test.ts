import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VisionUnsupportedError, type VisionRequest } from "../../../llm/index.js";
import type { RunProcess } from "../../audio/run-process.js";
import { extractMediaText, IMAGE_TEXT_PROMPT, mediaKindForPath, type VisionModel } from "./media-text.js";

// 1x1 PNG header bytes: enough for the image loader's type sniff.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

let dir: string;
let data: string;
let png: string;
let wav: string;
let ogg: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-text-test-"));
  data = await mkdtemp(join(tmpdir(), "media-text-data-"));
  png = join(dir, "scan.png");
  wav = join(dir, "memo.wav");
  ogg = join(dir, "voice.ogg");
  await writeFile(png, PNG);
  await writeFile(wav, "RIFF");
  await writeFile(ogg, "OggS");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
});

function visionModel(over: { canSee?: boolean; answer?: string; error?: Error } = {}) {
  const describeImage = vi.fn(async (_req: VisionRequest) => {
    if (over.error) throw over.error;
    return { text: over.answer ?? "  Invoice 42\nTotal: 10 EUR  ", durationMs: 1 };
  });
  const model = {
    name: "local-vlm",
    capabilities: { vision: over.canSee ?? true },
    describeImage,
  } as unknown as VisionModel;
  return { model, describeImage };
}

const MODEL = () => join(data, "whisper", "ggml-base.bin");

function audio(over: { binaries?: string[]; modelOnDisk?: boolean; run?: RunProcess } = {}) {
  const binaries = over.binaries ?? ["/bin/whisper-cli", "/bin/ffmpeg"];
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const run: RunProcess =
    over.run ??
    (async (cmd, args) => {
      calls.push({ cmd, args });
      return cmd.endsWith("whisper-cli")
        ? { code: 0, stdout: " Hello there.\n\n General Kenobi.\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    });
  const download = vi.fn(async (_url: string, _dest: string, _signal: AbortSignal) => undefined);
  const options = {
    enabled: true,
    localModelsDataDir: data,
    binaryLookup: {
      env: { PATH: "/bin" },
      platform: "darwin" as const,
      widenEnv: (e: NodeJS.ProcessEnv) => e,
      isExecutable: (p: string) => binaries.includes(p),
    },
    modelLookup: { env: {}, fileExists: (p: string) => (over.modelOnDisk ?? true) && p === MODEL() },
    run,
    download,
  };
  return { options, calls, download };
}

describe("mediaKindForPath", () => {
  it("classes photos and audio by extension, case-insensitively", () => {
    expect(mediaKindForPath("/a/b/photo.JPG")).toBe("image");
    expect(mediaKindForPath("x.webp")).toBe("image");
    expect(mediaKindForPath("voice.ogg")).toBe("audio");
    expect(mediaKindForPath("talk.M4A")).toBe("audio");
    expect(mediaKindForPath("doc.pdf")).toBeNull();
    expect(mediaKindForPath("noext")).toBeNull();
  });
});

describe("extractMediaText: switches", () => {
  it("is off by default and calls nothing", async () => {
    const { model, describeImage } = visionModel();
    const out = await extractMediaText(png, { vision: model });
    expect(out).toEqual({ status: "skipped", kind: "image", reason: "disabled" });
    expect(describeImage).not.toHaveBeenCalled();
  });

  it("skips files it does not handle", async () => {
    const out = await extractMediaText(join(dir, "notes.txt"), { enabled: true });
    expect(out).toMatchObject({ status: "skipped", kind: null, reason: "unsupported" });
  });

  it("skips files over the size cap", async () => {
    const { model, describeImage } = visionModel();
    const out = await extractMediaText(png, { enabled: true, maxBytes: 4, vision: model });
    expect(out).toMatchObject({ status: "skipped", reason: "too-large" });
    expect(describeImage).not.toHaveBeenCalled();
  });
});

describe("extractMediaText: photos go to the vision model", () => {
  it("sends the photo to describeImage with the copy-the-text prompt", async () => {
    const { model, describeImage } = visionModel();
    const out = await extractMediaText(png, { enabled: true, vision: model });
    expect(out).toEqual({ status: "ok", kind: "image", engine: "local-vlm", text: "Invoice 42\nTotal: 10 EUR" });
    expect(describeImage).toHaveBeenCalledTimes(1);
    const req = describeImage.mock.calls[0]![0];
    expect(req.prompt).toBe(IMAGE_TEXT_PROMPT);
    expect(req.images).toHaveLength(1);
    expect(req.images[0]!.mimeType).toBe("image/png");
    expect(Buffer.from(req.images[0]!.bytes)).toEqual(PNG);
  });

  it("takes the provider from a lookup, per call", async () => {
    const { model, describeImage } = visionModel();
    const out = await extractMediaText(png, { enabled: true, vision: () => model });
    expect(out.status).toBe("ok");
    expect(describeImage).toHaveBeenCalledTimes(1);
  });

  it("skips when no vision provider is wired", async () => {
    const out = await extractMediaText(png, { enabled: true, vision: () => undefined });
    expect(out).toMatchObject({ status: "skipped", reason: "no-vision-model" });
  });

  it("skips when the model cannot read images, without calling it", async () => {
    const { model, describeImage } = visionModel({ canSee: false });
    const out = await extractMediaText(png, { enabled: true, vision: model });
    expect(out).toMatchObject({ status: "skipped", reason: "no-vision-model" });
    expect(describeImage).not.toHaveBeenCalled();
  });

  it("skips when the model turns out not to see mid-call", async () => {
    const { model } = visionModel({ error: new VisionUnsupportedError("local-vlm") });
    const out = await extractMediaText(png, { enabled: true, vision: model });
    expect(out).toMatchObject({ status: "skipped", reason: "no-vision-model" });
  });

  it("reports other vision failures", async () => {
    const { model } = visionModel({ error: new Error("connection refused") });
    const out = await extractMediaText(png, { enabled: true, vision: model });
    expect(out).toMatchObject({ status: "failed", kind: "image", engine: "local-vlm", error: "connection refused" });
  });

  it("has no separate OCR engine left", async () => {
    const source = await readFile(new URL("./media-text.ts", import.meta.url), "utf8");
    expect(source.toLowerCase()).not.toContain("tesseract");
  });
});

describe("extractMediaText: audio goes through whisper.cpp", () => {
  it("converts with ffmpeg, runs whisper-cli on the base model and cleans the text", async () => {
    const { options, calls } = audio();
    const out = await extractMediaText(ogg, { ...options, transcriptionLanguage: "ru" });
    expect(out).toEqual({ status: "ok", kind: "audio", engine: "whisper.cpp", text: "Hello there.\nGeneral Kenobi." });
    expect(calls.map((c) => c.cmd)).toEqual(["/bin/ffmpeg", "/bin/whisper-cli"]);
    expect(calls[0]!.args).toContain(ogg);
    expect(calls[1]!.args).toEqual(expect.arrayContaining(["-m", MODEL(), "-l", "ru", "-nt", "-np"]));
  });

  it("does not fetch a missing model unless allowed, and says what it would fetch", async () => {
    const { options, calls, download } = audio({ modelOnDisk: false });
    const out = await extractMediaText(ogg, options);
    expect(out).toMatchObject({
      status: "skipped",
      reason: "needs-model-download",
      download: { model: "base", sizeMb: 142 },
    });
    if (out.status === "skipped") expect(out.download?.url).toContain("ggml-base.bin");
    expect(download).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("fetches the base model into the shared whisper folder when allowed, then transcribes", async () => {
    const { options, calls, download } = audio({ modelOnDisk: false });
    const out = await extractMediaText(ogg, { ...options, allowModelDownload: true });
    expect(out.status).toBe("ok");
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]![0]).toContain("ggml-base.bin");
    expect(download.mock.calls[0]![1]).toBe(MODEL());
    expect(calls.map((c) => c.cmd)).toEqual(["/bin/ffmpeg", "/bin/whisper-cli"]);
  });

  it("reports a failed download", async () => {
    const { options } = audio({ modelOnDisk: false });
    const out = await extractMediaText(ogg, {
      ...options,
      allowModelDownload: true,
      download: async () => {
        throw new Error("network down");
      },
    });
    expect(out).toMatchObject({ status: "failed", engine: "download", error: "network down" });
  });

  it("skips when whisper.cpp is not installed", async () => {
    const { options, calls } = audio({ binaries: ["/bin/ffmpeg"] });
    const out = await extractMediaText(ogg, options);
    expect(out).toMatchObject({ status: "skipped", reason: "no-engine" });
    expect(calls).toHaveLength(0);
  });

  it("skips non-WAV audio without ffmpeg, but runs a WAV as is", async () => {
    const { options, calls } = audio({ binaries: ["/bin/whisper-cli"] });
    expect(await extractMediaText(ogg, options)).toMatchObject({ status: "skipped", reason: "needs-ffmpeg" });
    const out = await extractMediaText(wav, options);
    expect(out.status).toBe("ok");
    expect(calls.map((c) => c.cmd)).toEqual(["/bin/whisper-cli"]);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["-f", wav]));
  });

  it("skips when no models folder is given", async () => {
    const { options } = audio();
    const out = await extractMediaText(ogg, { ...options, localModelsDataDir: undefined });
    expect(out).toMatchObject({ status: "skipped", reason: "no-model" });
  });

  it("reports whisper and ffmpeg failures", async () => {
    const failWhisper = audio({
      run: async (cmd) =>
        cmd.endsWith("whisper-cli") ? { code: 1, stdout: "", stderr: "bad model" } : { code: 0, stdout: "", stderr: "" },
    });
    expect(await extractMediaText(ogg, failWhisper.options)).toMatchObject({ status: "failed", engine: "whisper.cpp", error: "bad model" });
    const failFfmpeg = audio({ run: async () => ({ code: 1, stdout: "", stderr: "Invalid data found" }) });
    expect(await extractMediaText(ogg, failFfmpeg.options)).toMatchObject({ status: "failed", engine: "ffmpeg" });
  });
});
