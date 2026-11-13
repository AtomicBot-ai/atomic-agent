import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whisperCommand } from "./whisper-command.js";
import type { InstallDeps } from "../tools/audio/whisper-install.js";
import { whisperModelById } from "../tools/audio/whisper-models.js";
import { managedWhisperBinary, whisperAssetFor } from "../tools/audio/whisper-release.js";

let data: string;
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "whisper-cmd-"));
});
afterEach(() => {
  rmSync(data, { recursive: true, force: true });
});

function fakeNet(): InstallDeps & { urls: string[] } {
  const urls: string[] = [];
  const sha = new Map<string, string>();
  return {
    urls,
    download: async (url, dest, o) => {
      urls.push(url);
      writeFileSync(dest, "x");
      const m = ["base", "small"].map((id) => whisperModelById(id)!).find((x) => url.endsWith(x.file));
      const a = whisperAssetFor("linux", "x64")!;
      sha.set(dest, m?.sha256 ?? a.sha256);
      const size = m?.sizeBytes ?? a.sizeBytes;
      o.onProgress(size / 2, size);
      o.onProgress(size, size);
    },
    hashFile: async (p) => sha.get(p) ?? "",
    extract: async (_a, _f, dest) => {
      mkdirSync(join(dest, "whisper-bin-ubuntu-x64"), { recursive: true });
      writeFileSync(join(dest, "whisper-bin-ubuntu-x64", "whisper-cli"), "");
    },
  };
}

async function run(args: string[], over: { platform?: NodeJS.Platform; net?: InstallDeps } = {}) {
  const lines: string[] = [];
  const code = await whisperCommand(args, {
    write: (t) => lines.push(...t.split("\n").filter(Boolean)),
    dataDir: () => data,
    platform: over.platform ?? "linux",
    arch: "x64",
    install: over.net ?? fakeNet(),
    signal: new AbortController().signal,
    // Only what this test put in the data folder counts, not a real whisper-cli on PATH.
    binaryLookup: { env: { PATH: "" }, widenEnv: (e) => e, isExecutable: (p) => existsSync(p) },
  });
  return { code, lines };
}

describe("atomic-agent whisper (ATO-702)", () => {
  it("install --json on Linux with nothing there: engine then model, progress lines, then done", async () => {
    const net = fakeNet();
    const { code, lines } = await run(["install", "--json"], { net });
    expect(code).toBe(0);
    const events = lines.map((l) => JSON.parse(l) as { type: string; item?: string; fraction?: number; model?: string });
    const progress = events.filter((e) => e.type === "progress");
    expect(progress.map((e) => e.item)).toContain("engine");
    expect(progress.map((e) => e.item)).toContain("model");
    expect(progress.at(-1)!.fraction).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "done", model: "base", binary: managedWhisperBinary(data, "linux") });
    expect(net.urls).toEqual([
      "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-x64.tar.gz",
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    ]);
  });

  it("with the default set to small, install fetches small", async () => {
    expect((await run(["default", "small"])).code).toBe(0);
    expect(JSON.parse(readFileSync(join(data, "whisper", "settings.json"), "utf8"))).toEqual({ defaultModel: "small" });
    const net = fakeNet();
    const { code } = await run(["install", "--json"], { net });
    expect(code).toBe(0);
    expect(net.urls.at(-1)).toBe("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin");
    expect(existsSync(join(data, "whisper", "ggml-small.bin"))).toBe(true);
  });

  it("on macOS without whisper.cpp says brew and downloads nothing", async () => {
    const net = fakeNet();
    const { code, lines } = await run(["install", "--json"], { platform: "darwin", net });
    expect(code).toBe(1);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ type: "error", code: "whisper-missing" });
    expect(lines.at(-1)).toContain("brew install whisper-cpp");
    expect(net.urls).toEqual([]);
  });

  it("status --json reports the default and what is installed", async () => {
    const { code, lines } = await run(["status", "--json"]);
    expect(code).toBe(0);
    const s = JSON.parse(lines[0]!) as { defaultModel: string; downloadable: boolean; models: Array<{ id: string; installed: boolean }> };
    expect(s.defaultModel).toBe("base");
    expect(s.downloadable).toBe(true);
    expect(s.models.find((m) => m.id === "base")?.installed).toBe(false);
  });

  it("rejects unknown models and commands", async () => {
    expect((await run(["default", "huge"])).code).toBe(2);
    expect((await run(["install", "--model", "huge"])).code).toBe(2);
    expect((await run(["frobnicate"])).code).toBe(2);
  });
});
