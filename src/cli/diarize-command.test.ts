import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { diarizeCommand, diarizeInstalled, type DiarizeCommandDeps } from "./diarize-command.js";
import type { DiarizeInstallDeps } from "../tools/audio/diarize-install.js";
import { DIARIZE_MODELS, diarizeAssetFor, diarizeModelPath, managedDiarizeBinary } from "../tools/audio/diarize-release.js";

let data: string;
beforeEach(() => { data = mkdtempSync(join(tmpdir(), "diarize-cmd-")); });
afterEach(() => { rmSync(data, { recursive: true, force: true }); });

function cmd(args: string[], extra: Partial<DiarizeCommandDeps> = {}) {
  const lines: string[] = [];
  const signal = new AbortController().signal;
  const run = diarizeCommand(args, { write: (t) => lines.push(t), dataDir: () => data, platform: "linux", arch: "x64", signal, ...extra });
  return run.then((code) => ({ code, out: lines.join(""), json: lines.join("").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { text: l }; } }) }));
}

/** What a finished install leaves: the CLI and both models at full size (sparse files). */
function installed() {
  const bin = managedDiarizeBinary(data, "linux");
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, "");
  for (const m of DIARIZE_MODELS) {
    const p = diarizeModelPath(data, m);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "");
    truncateSync(p, m.sizeBytes);
  }
}

function fakeNet(): DiarizeInstallDeps {
  const asset = diarizeAssetFor("linux", "x64")!;
  const digests = new Map<string, string>();
  return {
    download: async (url, dest, o) => {
      const m = DIARIZE_MODELS.find((x) => x.url === url);
      writeFileSync(dest, "");
      if (m) truncateSync(dest, m.sizeBytes);
      digests.set(dest, m ? m.sha256 : asset.sha256);
      o.onProgress((m ?? asset).sizeBytes, (m ?? asset).sizeBytes);
    },
    hashFile: async (p) => digests.get(p) ?? "",
    extract: async (_a, dest) => {
      mkdirSync(join(dest, "x", "bin"), { recursive: true });
      writeFileSync(join(dest, "x", "bin", "sherpa-onnx-offline-speaker-diarization"), "");
    },
  };
}

describe("atomic-agent diarize (ATO-2514)", () => {
  it("status says it is not installed and what the first use downloads", async () => {
    const r = await cmd(["status", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json[0]).toMatchObject({ type: "status", installed: false, supported: true, release: "v1.13.8" });
    expect(r.json[0].downloadBytes).toBeGreaterThan(50_000_000);
  });

  it("install downloads the engine and both models with progress, then status says installed", async () => {
    const r = await cmd(["install", "--json"], { install: fakeNet() });
    expect(r.code).toBe(0);
    expect(r.json.filter((e) => e.type === "progress").length).toBeGreaterThan(0);
    expect(r.json.at(-1)).toMatchObject({ type: "done" });
    expect(diarizeInstalled(data, "linux")).toBe(true);
  });

  it("run refuses before install, and reads the speaker turns after", async () => {
    expect((await cmd(["run", "/t/a.wav", "--json"])).json[0]).toMatchObject({ type: "error", code: "not-installed" });
    installed();
    const calls: unknown[] = [];
    const run = async (_bin: string, input: unknown) => {
      calls.push(input);
      return { ok: true, spans: [{ start: 0, end: 2, speaker: 0 }, { start: 2.5, end: 4, speaker: 1 }] };
    };
    const r = await cmd(["run", "--speakers", "2", "/t/a.wav", "--json"], { run });
    expect(r.code).toBe(0);
    expect(r.json.at(-1)).toMatchObject({ type: "done", speakers: 2 });
    expect(calls[0]).toMatchObject({ wav: "/t/a.wav", speakers: 2 });
  });

  it("refuses a bad speaker count and an unknown sub-command", async () => {
    expect((await cmd(["run", "/t/a.wav", "--speakers", "0"])).code).toBe(2);
    expect((await cmd(["frobnicate"])).code).toBe(2);
  });
});
