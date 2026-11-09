import { describe, expect, it } from "vitest";

import { MIN_AUTO_CONTEXT } from "./context-size.js";
import { decidePartialOffloadShrink, parseGpuOffload } from "./partial-offload.js";

describe("parseGpuOffload (ATO-868)", () => {
  it("reads every layer on the GPU", () => {
    expect(parseGpuOffload("load_tensors: offloaded 65/65 layers to GPU\n")).toEqual({ offloaded: 65, total: 65 });
  });

  it("reads part of the layers on the GPU", () => {
    expect(
      parseGpuOffload("load_tensors: loading model tensors\nload_tensors: offloaded 41/65 layers to GPU\nload_tensors: CPU_Mapped model buffer size"),
    ).toEqual({ offloaded: 41, total: 65 });
  });

  it("takes the last report when the log has several", () => {
    expect(
      parseGpuOffload("load_tensors: offloaded 65/65 layers to GPU\n...\nload_tensors: offloaded 30/65 layers to GPU\n"),
    ).toEqual({ offloaded: 30, total: 65 });
  });

  it("is null when the log has no such line", () => {
    expect(parseGpuOffload("main: HTTP server is listening\n")).toBeNull();
    expect(parseGpuOffload("")).toBeNull();
  });
});

describe("decidePartialOffloadShrink (ATO-868)", () => {
  const base = {
    configuredContextSize: 0,
    device: "CUDA0",
    contextSize: 131_072,
    offload: { offloaded: 41, total: 65 },
    alreadyRetried: false,
  };

  it("halves an auto window once when some layers stayed on the CPU", () => {
    expect(decidePartialOffloadShrink(base)).toEqual({ from: 131_072, to: 65_536, offloaded: 41, total: 65 });
  });

  it("restarts exactly once: never on the retry itself", () => {
    expect(decidePartialOffloadShrink({ ...base, alreadyRetried: true })).toBeNull();
  });

  it("never touches a context the operator pinned", () => {
    expect(decidePartialOffloadShrink({ ...base, configuredContextSize: 131_072 })).toBeNull();
  });

  it("does nothing when every layer is on the GPU, or the log does not say", () => {
    expect(decidePartialOffloadShrink({ ...base, offload: { offloaded: 65, total: 65 } })).toBeNull();
    expect(decidePartialOffloadShrink({ ...base, offload: null })).toBeNull();
  });

  it("does nothing on the CPU device", () => {
    expect(decidePartialOffloadShrink({ ...base, device: "cpu" })).toBeNull();
  });

  it("never goes below the auto floor, and does nothing at it", () => {
    expect(decidePartialOffloadShrink({ ...base, contextSize: 49_152 })).toEqual({
      from: 49_152,
      to: MIN_AUTO_CONTEXT,
      offloaded: 41,
      total: 65,
    });
    expect(decidePartialOffloadShrink({ ...base, contextSize: MIN_AUTO_CONTEXT })).toBeNull();
  });

  it("keeps the new window a multiple of 1024", () => {
    expect(decidePartialOffloadShrink({ ...base, contextSize: 112_640 })?.to).toBe(56_320);
    expect(decidePartialOffloadShrink({ ...base, contextSize: 113_664 })?.to).toBe(56_320);
  });
});
