import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MacosTooOldError,
  assertBackendRunsOnThisMac,
  macosTooOldMessage,
  macosVersionFromDarwin,
  readMachOMinimumMacos,
} from "./macos-min-version.js";

const pack = (major: number, minor: number) => (major << 16) | (minor << 8);

/** A thin arm64 Mach-O header with one LC_SEGMENT-like filler and one version command. */
function thin(opts: { minos?: [number, number]; legacy?: [number, number]; platform?: number } = {}): Buffer {
  const commands: Buffer[] = [];
  const filler = Buffer.alloc(16);
  filler.writeUInt32LE(0x19, 0); // LC_SEGMENT_64, contents irrelevant here
  filler.writeUInt32LE(16, 4);
  commands.push(filler);
  if (opts.minos) {
    const c = Buffer.alloc(24);
    c.writeUInt32LE(0x32, 0);
    c.writeUInt32LE(24, 4);
    c.writeUInt32LE(opts.platform ?? 1, 8);
    c.writeUInt32LE(pack(...opts.minos), 12);
    c.writeUInt32LE(pack(26, 5), 16);
    commands.push(c);
  }
  if (opts.legacy) {
    const c = Buffer.alloc(16);
    c.writeUInt32LE(0x24, 0);
    c.writeUInt32LE(16, 4);
    c.writeUInt32LE(pack(...opts.legacy), 8);
    commands.push(c);
  }
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(commands.length, 16);
  return Buffer.concat([header, ...commands]);
}

/** A universal binary with an x86_64 slice (macOS 13.0) and an arm64 slice. */
function fat(arm64: Buffer): Buffer {
  const x64 = thin({ minos: [13, 0] });
  const head = Buffer.alloc(8 + 2 * 20);
  head.writeUInt32BE(0xcafebabe, 0);
  head.writeUInt32BE(2, 4);
  const x64At = head.length;
  const armAt = x64At + x64.length;
  head.writeUInt32BE(0x01000007, 8);
  head.writeUInt32BE(x64At, 16);
  head.writeUInt32BE(x64.length, 20);
  head.writeUInt32BE(0x0100000c, 28);
  head.writeUInt32BE(armAt, 36);
  head.writeUInt32BE(arm64.length, 40);
  return Buffer.concat([head, x64, arm64]);
}

describe("readMachOMinimumMacos", () => {
  it("reads LC_BUILD_VERSION and the older LC_VERSION_MIN_MACOSX", () => {
    expect(readMachOMinimumMacos(thin({ minos: [26, 0] }))).toEqual({ major: 26, minor: 0 });
    expect(readMachOMinimumMacos(thin({ legacy: [10, 15] }))).toEqual({ major: 10, minor: 15 });
  });

  it("picks the slice for this architecture in a universal binary", () => {
    const universal = fat(thin({ minos: [26, 0] }));
    expect(readMachOMinimumMacos(universal, "arm64")).toEqual({ major: 26, minor: 0 });
    expect(readMachOMinimumMacos(universal, "x64")).toEqual({ major: 13, minor: 0 });
  });

  it("declines bytes it cannot vouch for", () => {
    expect(readMachOMinimumMacos(Buffer.from("#!/bin/sh\n"))).toBeNull();
    expect(readMachOMinimumMacos(thin())).toBeNull();
    expect(readMachOMinimumMacos(thin({ minos: [26, 0], platform: 2 }))).toBeNull();
    expect(readMachOMinimumMacos(thin({ minos: [26, 0] }).subarray(0, 40))).toBeNull();
  });
});

describe("macosVersionFromDarwin", () => {
  it("maps Darwin kernels to macOS, across the 2025 renumbering", () => {
    expect(macosVersionFromDarwin("20.6.0")).toEqual({ major: 11, minor: 6 });
    expect(macosVersionFromDarwin("23.4.0")).toEqual({ major: 14, minor: 4 });
    expect(macosVersionFromDarwin("24.6.0")).toEqual({ major: 15, minor: 6 });
    expect(macosVersionFromDarwin("25.0.0")).toEqual({ major: 26, minor: 0 });
    expect(macosVersionFromDarwin("19.6.0")).toBeNull();
    expect(macosVersionFromDarwin("unknown")).toBeNull();
  });
});

describe("macosTooOldMessage", () => {
  it("speaks only when the binary needs a newer major macOS", () => {
    expect(macosTooOldMessage({ major: 26, minor: 0 }, { major: 15, minor: 6 })).toMatch(/needs macOS 26\.0 or later.*runs macOS 15\.6/);
    expect(macosTooOldMessage({ major: 26, minor: 0 }, { major: 26, minor: 0 })).toBeNull();
    expect(macosTooOldMessage({ major: 14, minor: 0 }, { major: 15, minor: 6 })).toBeNull();
    expect(macosTooOldMessage(null, { major: 15, minor: 6 })).toBeNull();
    expect(macosTooOldMessage({ major: 26, minor: 0 }, null)).toBeNull();
  });
});

describe("assertBackendRunsOnThisMac", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  function binary(bytes: Buffer): string {
    dir = mkdtempSync(join(tmpdir(), "macos-min-"));
    const path = join(dir, "llama-server");
    writeFileSync(path, bytes);
    return path;
  }

  it("refuses a macOS 26 build on macOS 15 before it is spawned", () => {
    const path = binary(thin({ minos: [26, 0] }));
    expect(() => assertBackendRunsOnThisMac(path, { platform: "darwin", darwinRelease: "24.6.0", arch: "arm64" })).toThrow(MacosTooOldError);
  });

  it("reads a universal binary's slice where it lies, past the first 64 KiB", () => {
    const x64 = Buffer.concat([thin({ minos: [13, 0] }), Buffer.alloc(0x20000)]);
    const arm64 = thin({ minos: [26, 0] });
    const head = Buffer.alloc(8 + 2 * 20);
    head.writeUInt32BE(0xcafebabe, 0);
    head.writeUInt32BE(2, 4);
    const x64At = 0x1000;
    const armAt = x64At + x64.length;
    head.writeUInt32BE(0x01000007, 8);
    head.writeUInt32BE(x64At, 16);
    head.writeUInt32BE(x64.length, 20);
    head.writeUInt32BE(0x0100000c, 28);
    head.writeUInt32BE(armAt, 36);
    head.writeUInt32BE(arm64.length, 40);
    const bytes = Buffer.concat([head, Buffer.alloc(x64At - head.length), x64, arm64]);
    const path = binary(bytes);
    expect(() => assertBackendRunsOnThisMac(path, { platform: "darwin", darwinRelease: "24.6.0", arch: "arm64" })).toThrow(MacosTooOldError);
    expect(() => assertBackendRunsOnThisMac(path, { platform: "darwin", darwinRelease: "24.6.0", arch: "x64" })).not.toThrow();
  });

  it("lets a build run where it can, off macOS, and when nothing is readable", () => {
    const path = binary(thin({ minos: [14, 0] }));
    expect(() => assertBackendRunsOnThisMac(path, { platform: "darwin", darwinRelease: "24.6.0", arch: "arm64" })).not.toThrow();
    expect(() => assertBackendRunsOnThisMac(path, { platform: "darwin", darwinRelease: "25.1.0", arch: "arm64" })).not.toThrow();
    expect(() => assertBackendRunsOnThisMac(path, { platform: "linux", darwinRelease: "1.0.0" })).not.toThrow();
    expect(() => assertBackendRunsOnThisMac(join(dir!, "missing"), { platform: "darwin", darwinRelease: "24.6.0" })).not.toThrow();
  });
});
