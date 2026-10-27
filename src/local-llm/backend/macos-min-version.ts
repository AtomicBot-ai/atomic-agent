import { closeSync, openSync, readSync } from "node:fs";
import { release } from "node:os";

/**
 * ATO-116: a llama-server built on a newer macOS than the one it runs on.
 *
 * The TurboQuant macOS builds (both the agent's own nightly and the build
 * Atomic Core installs from its catalog) are compiled on GitHub's
 * `macos-latest` image without a deployment target, so the linker stamps
 * the build machine's macOS as the minimum (`LC_BUILD_VERSION minos 26.0`
 * on the current image). dyld then refuses to load the binary on any older
 * macOS, the process dies before it prints a line, and the start reads as a
 * crash or a health timeout. This module reads that stamp so the start can
 * say so plainly instead. The real fix is the build's deployment target
 * (`-DCMAKE_OSX_DEPLOYMENT_TARGET`), which lives in the backend repos.
 */

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_TYPE_X86_64 = 0x01000007;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const PLATFORM_MACOS = 1;
/** Load commands sit right after the header; 64 KiB covers every real binary. */
const HEADER_READ_BYTES = 64 * 1024;

export interface MacosVersion {
  major: number;
  minor: number;
}

function decodeVersion(packed: number): MacosVersion {
  return { major: packed >>> 16, minor: (packed >>> 8) & 0xff };
}

/** `minos` of one thin 64-bit Mach-O image starting at `offset`, or null. */
function thinMinimum(buf: Buffer, offset: number): MacosVersion | null {
  if (buf.length < offset + 32 || buf.readUInt32LE(offset) !== MH_MAGIC_64) return null;
  const ncmds = buf.readUInt32LE(offset + 16);
  let p = offset + 32;
  for (let i = 0; i < ncmds && p + 8 <= buf.length; i++) {
    const cmd = buf.readUInt32LE(p);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8) return null;
    if (cmd === LC_BUILD_VERSION && p + 16 <= buf.length) {
      if (buf.readUInt32LE(p + 8) !== PLATFORM_MACOS) return null;
      return decodeVersion(buf.readUInt32LE(p + 12));
    }
    if (cmd === LC_VERSION_MIN_MACOSX && p + 12 <= buf.length) {
      return decodeVersion(buf.readUInt32LE(p + 8));
    }
    p += size;
  }
  return null;
}

/**
 * The minimum macOS a Mach-O binary declares, for the slice matching
 * `arch` in a universal binary. Null when the bytes are not a 64-bit
 * Mach-O or declare nothing. Pure.
 */
export function readMachOMinimumMacos(buf: Buffer, arch: string = process.arch): MacosVersion | null {
  if (buf.length < 8) return null;
  const magic = buf.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return thinMinimum(buf, 0);
  const wanted = arch === "x64" ? CPU_TYPE_X86_64 : CPU_TYPE_ARM64;
  const count = buf.readUInt32BE(4);
  const entry = magic === FAT_MAGIC_64 ? 32 : 20;
  for (let i = 0; i < count; i++) {
    const at = 8 + i * entry;
    if (at + entry > buf.length) return null;
    if (buf.readUInt32BE(at) !== wanted) continue;
    const offset = magic === FAT_MAGIC_64 ? Number(buf.readBigUInt64BE(at + 8)) : buf.readUInt32BE(at + 8);
    return thinMinimum(buf, offset);
  }
  return null;
}

/**
 * The macOS version for a Darwin kernel release (`os.release()`):
 * Darwin 20-24 are macOS 11-15, Darwin 25 is macOS 26 (Apple's 2025
 * renumbering). Null for anything older or unparsable. Pure.
 */
export function macosVersionFromDarwin(darwinRelease: string): MacosVersion | null {
  const match = /^(\d+)\.(\d+)/.exec(darwinRelease.trim());
  if (!match) return null;
  const darwin = Number(match[1]);
  const minor = Number(match[2]);
  if (darwin < 20) return null;
  return { major: darwin >= 25 ? darwin + 1 : darwin - 9, minor };
}

/**
 * The sentence for a backend this Mac cannot load, or null when it can
 * (or when either version is unknown, so nothing is refused on a guess).
 * Only the major version is compared: Darwin's minor does not always
 * match the macOS point release. Pure.
 */
export function macosTooOldMessage(required: MacosVersion | null, host: MacosVersion | null): string | null {
  if (!required || !host || required.major <= host.major) return null;
  return (
    `The local model engine installed on this Mac needs macOS ${required.major}.${required.minor} or later, ` +
    `and this Mac runs macOS ${host.major}.${host.minor}, so it cannot start. ` +
    `Update macOS, or use a cloud model until an engine build for your macOS version is published.`
  );
}

/** First bytes of a file, or null when it cannot be read. */
function readHead(path: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(HEADER_READ_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A llama-server this Mac's dyld would refuse to load. */
export class MacosTooOldError extends Error {
  constructor(
    message: string,
    readonly required: MacosVersion,
    readonly host: MacosVersion,
  ) {
    super(message);
    this.name = "MacosTooOldError";
  }
}

/**
 * Throw `MacosTooOldError` before spawning a backend binary that declares
 * a newer minimum macOS than this Mac runs. A no-op off macOS, and when
 * the binary or the host version cannot be read.
 */
export function assertBackendRunsOnThisMac(
  binPath: string,
  opts: { platform?: NodeJS.Platform; darwinRelease?: string; arch?: string } = {},
): void {
  if ((opts.platform ?? process.platform) !== "darwin") return;
  const head = readHead(binPath);
  if (!head) return;
  const required = readMachOMinimumMacos(head, opts.arch ?? process.arch);
  const host = macosVersionFromDarwin(opts.darwinRelease ?? release());
  const message = macosTooOldMessage(required, host);
  if (message && required && host) throw new MacosTooOldError(message, required, host);
}
