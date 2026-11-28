import { describe, expect, it } from "vitest";
import { diarizeArgs, diarizeEnv, parseDiarizeOutput, parseDiarizeProgress } from "./diarize-run.js";

describe("sherpa-onnx diarizer output (ATO-2514)", () => {
  it("reads the speaker lines and skips the config and timing lines", () => {
    const stdout = [
      "OfflineSpeakerDiarizationConfig(segmentation=..., embedding=..., clustering=FastClusteringConfig(num_clusters=-1, threshold=0.5))",
      "Started",
      "7.017 -- 10.747 speaker_01",
      "0.318 -- 6.865 speaker_00",
      "11.000 -- 11.000 speaker_00",
      "12.500 -- 14.250 speaker_02 confidence=0.913",
      "",
    ].join("\n");
    expect(parseDiarizeOutput(stdout)).toEqual([
      { start: 0.318, end: 6.865, speaker: 0 },
      { start: 7.017, end: 10.747, speaker: 1 },
      { start: 12.5, end: 14.25, speaker: 2 },
    ]);
    expect(parseDiarizeOutput("")).toEqual([]);
  });

  it("reads progress lines from stderr", () => {
    expect(parseDiarizeProgress("progress 37.50%")).toBe(0.375);
    expect(parseDiarizeProgress("progress 100.00%")).toBe(1);
    expect(parseDiarizeProgress("Duration : 3.000 s")).toBeNull();
  });

  it("passes the models, the speaker count or the threshold, then the file", () => {
    const base = { segmentation: "/m/seg.onnx", embedding: "/m/emb.onnx", wav: "/t/a.wav" };
    expect(diarizeArgs(base)).toEqual(["--segmentation.pyannote-model=/m/seg.onnx", "--embedding.model=/m/emb.onnx", "/t/a.wav"]);
    expect(diarizeArgs({ ...base, speakers: 3 })).toContain("--clustering.num-clusters=3");
    expect(diarizeArgs({ ...base, threshold: 0.7 })).toContain("--clustering.cluster-threshold=0.7");
    expect(diarizeArgs({ ...base, speakers: 0, threshold: 9 })).toHaveLength(3);
  });

  it("puts the build's bin and lib folders on each OS's library path", () => {
    const mac = diarizeEnv("/d/v1/bin/sherpa-onnx-offline-speaker-diarization", "darwin", { DYLD_LIBRARY_PATH: "/old" });
    expect(mac.DYLD_LIBRARY_PATH).toBe("/d/v1/bin:/d/v1/lib:/old");
    const linux = diarizeEnv("/d/v1/bin/sherpa-onnx-offline-speaker-diarization", "linux", {});
    expect(linux.LD_LIBRARY_PATH).toBe("/d/v1/bin:/d/v1/lib");
    const win = diarizeEnv("C:/d/v1/bin/sherpa-onnx-offline-speaker-diarization.exe", "win32", { PATH: "C:/Windows" });
    expect(win.PATH).toBeUndefined();
    expect(win.Path).toBe("C:/d/v1/bin;C:/d/v1/lib;C:/Windows");
  });
});
