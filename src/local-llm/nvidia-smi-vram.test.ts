import { describe, expect, it } from "vitest";
import { parseNvidiaVramMiB } from "./nvidia-smi-vram.js";

describe("parseNvidiaVramMiB", () => {
  it("parses a single GPU memory.total line", () => {
    expect(parseNvidiaVramMiB("8188\n")).toBe(8188);
  });

  it("returns the maximum across multiple GPUs", () => {
    expect(parseNvidiaVramMiB("8188\n24564\n6144\n")).toBe(24564);
  });

  it("tolerates surrounding whitespace and blank lines", () => {
    expect(parseNvidiaVramMiB("  8188  \n\n  4096\n")).toBe(8188);
  });

  it("returns null for empty output", () => {
    expect(parseNvidiaVramMiB("")).toBeNull();
    expect(parseNvidiaVramMiB("\n\n")).toBeNull();
  });

  it("returns null when nothing parses to a positive number", () => {
    expect(parseNvidiaVramMiB("N/A\n")).toBeNull();
    expect(parseNvidiaVramMiB("0\n")).toBeNull();
  });

  it("ignores trailing units if present (nounits is the happy path)", () => {
    // `--format=...,nounits` strips units, but be defensive: parseInt
    // stops at the first non-digit so "8188 MiB" still yields 8188.
    expect(parseNvidiaVramMiB("8188 MiB\n")).toBe(8188);
  });
});
