import { describe, expect, it } from "vitest";

import {
  IMAGE_SNIFF_PREFIX_BYTES,
  sniffImageType,
  type SniffedImageType,
} from "./sniff-image-type.js";

const ascii = (text: string): number[] =>
  Array.from(text, (char) => char.charCodeAt(0));

/**
 * Fixtures are built from magic bytes in-test on purpose: a checked-in
 * binary would be one more opaque file nobody can diff, and the header
 * is the entire subject of these tests. `tail` stands in for the rest of
 * a real file and is deliberately garbage — nothing may depend on it.
 */
function withHeader(header: number[], tailBytes = 64): Uint8Array {
  const out = new Uint8Array(header.length + tailBytes);
  out.set(header, 0);
  out.fill(0xa5, header.length);
  return out;
}

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0];
const GIF87A_HEADER = ascii("GIF87a");
const GIF89A_HEADER = ascii("GIF89a");
// RIFF, then a four-byte little-endian chunk length that carries no
// signal, then the WEBP form type.
const WEBP_HEADER = [
  ...ascii("RIFF"),
  0x24,
  0x00,
  0x00,
  0x00,
  ...ascii("WEBP"),
];

describe("sniffImageType", () => {
  const supported: Array<{
    name: string;
    header: number[];
    expected: SniffedImageType;
  }> = [
    { name: "PNG", header: PNG_HEADER, expected: "image/png" },
    { name: "JPEG", header: JPEG_HEADER, expected: "image/jpeg" },
    { name: "GIF87a", header: GIF87A_HEADER, expected: "image/gif" },
    { name: "GIF89a", header: GIF89A_HEADER, expected: "image/gif" },
    { name: "WebP", header: WEBP_HEADER, expected: "image/webp" },
  ];

  for (const { name, header, expected } of supported) {
    it(`identifies ${name} from its signature`, () => {
      expect(sniffImageType(withHeader(header))).toBe(expected);
    });
  }

  const unrecognised: Array<{ name: string; bytes: Uint8Array }> = [
    { name: "plain text", bytes: new Uint8Array(ascii("not an image at all")) },
    { name: "all zeroes", bytes: new Uint8Array(64) },
    // A PDF is a real file with a real signature — just not one we send.
    { name: "a PDF", bytes: withHeader(ascii("%PDF-1.7")) },
    // RIFF container that is not WebP (a WAV): the first pattern matches
    // and the second must still reject it.
    {
      name: "a RIFF/WAVE container",
      bytes: withHeader([
        ...ascii("RIFF"),
        0x24,
        0x00,
        0x00,
        0x00,
        ...ascii("WAVE"),
      ]),
    },
    // One byte off in the PNG signature: the trailing 0x0A that catches
    // CRLF-mangled transfers.
    {
      name: "a PNG signature with a corrupted final byte",
      bytes: withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0d]),
    },
  ];

  for (const { name, bytes } of unrecognised) {
    it(`returns null for ${name}`, () => {
      expect(sniffImageType(bytes)).toBeNull();
    });
  }

  it("returns null for an empty buffer", () => {
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });

  it("returns null for a prefix too short to decide", () => {
    // The first four bytes of the PNG signature — right, as far as they
    // go, and not enough. "No opinion" is the correct answer, not a
    // guess: `loadImageFile` falls back to the extension on null.
    expect(sniffImageType(new Uint8Array(PNG_HEADER.slice(0, 4)))).toBeNull();
    // RIFF with nothing where the form type belongs.
    expect(sniffImageType(new Uint8Array(ascii("RIFF")))).toBeNull();
  });

  it("identifies a file that is exactly its signature and nothing else", () => {
    expect(sniffImageType(new Uint8Array(PNG_HEADER))).toBe("image/png");
    expect(sniffImageType(new Uint8Array(JPEG_HEADER.slice(0, 3)))).toBe(
      "image/jpeg",
    );
  });

  /**
   * The sniffer is handed whole files — an 8 MB screenshot included — so
   * "reads a bounded prefix" is a real property, not a nicety. A Proxy
   * records the highest index actually indexed.
   */
  function trackReads(bytes: Uint8Array): {
    view: Uint8Array;
    maxIndex: () => number;
  } {
    let maxIndex = -1;
    const view = new Proxy(bytes, {
      get(target, prop) {
        if (typeof prop === "string") {
          const index = Number(prop);
          if (Number.isInteger(index) && index >= 0) {
            maxIndex = Math.max(maxIndex, index);
          }
        }
        // `target`, not the proxy, as the receiver: `length` is a
        // prototype accessor that needs the typed-array internal slot.
        return Reflect.get(target, prop);
      },
    }) as Uint8Array;
    return { view, maxIndex: () => maxIndex };
  }

  it("never indexes past the declared prefix, whatever the input", () => {
    for (const { header } of supported) {
      const tracked = trackReads(withHeader(header, 4096));
      expect(sniffImageType(tracked.view)).not.toBeNull();
      expect(tracked.maxIndex()).toBeLessThan(IMAGE_SNIFF_PREFIX_BYTES);
    }
    for (const { bytes } of unrecognised) {
      const tracked = trackReads(bytes);
      expect(sniffImageType(tracked.view)).toBeNull();
      expect(tracked.maxIndex()).toBeLessThan(IMAGE_SNIFF_PREFIX_BYTES);
    }
  });

  it("stops at the first mismatching byte of a signature", () => {
    // A JPEG never has its bytes 3..11 inspected: PNG fails at byte 0,
    // both GIFs fail at byte 0, RIFF fails at byte 0, and JPEG itself
    // is decided by bytes 0..2.
    const tracked = trackReads(withHeader(JPEG_HEADER, 4096));
    expect(sniffImageType(tracked.view)).toBe("image/jpeg");
    expect(tracked.maxIndex()).toBe(2);
  });
});
