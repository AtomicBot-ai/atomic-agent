import { describe, it, expect } from "vitest";
import { detectArchiveFormat } from "./format-detector.js";

function head(bytes: number[], total = 512): Buffer {
  const buf = Buffer.alloc(total);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b !== undefined) buf[i] = b;
  }
  return buf;
}

function tarLikeHeader(): Buffer {
  const buf = Buffer.alloc(512);
  buf.write("ustar\0", 257, "ascii");
  return buf;
}

describe("detectArchiveFormat", () => {
  it("detects zip by magic + extension", () => {
    const buf = head([0x50, 0x4b, 0x03, 0x04]);
    expect(detectArchiveFormat("foo.zip", buf)).toBe("zip");
  });

  it("rejects .zip without PK magic", () => {
    expect(detectArchiveFormat("foo.zip", head([0, 0, 0, 0]))).toBe(null);
  });

  it("detects gzipped tar via .tar.gz", () => {
    const buf = head([0x1f, 0x8b, 0x08, 0x00]);
    expect(detectArchiveFormat("foo.tar.gz", buf)).toBe("tar.gz");
    expect(detectArchiveFormat("foo.tgz", buf)).toBe("tar.gz");
  });

  it("detects plain tar via ustar magic", () => {
    expect(detectArchiveFormat("foo.tar", tarLikeHeader())).toBe("tar");
  });

  it("detects lone gzip", () => {
    const buf = head([0x1f, 0x8b, 0x08, 0x00]);
    expect(detectArchiveFormat("foo.gz", buf)).toBe("gz");
  });

  it("falls back to magic when extension is unknown", () => {
    expect(detectArchiveFormat("weird", head([0x50, 0x4b, 0x03, 0x04]))).toBe("zip");
    expect(detectArchiveFormat("weird", head([0x1f, 0x8b, 0x00, 0x00]))).toBe("gz");
    expect(detectArchiveFormat("weird", tarLikeHeader())).toBe("tar");
  });

  it("returns null for unknown content", () => {
    expect(detectArchiveFormat("mystery.dat", head([0, 0, 0, 0]))).toBe(null);
  });
});
