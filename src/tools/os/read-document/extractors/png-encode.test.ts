import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { crc32, encodePng } from "./png-encode.js";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Chunk {
  type: string;
  body: Buffer;
  crc: number;
}

function chunks(png: Buffer): Chunk[] {
  const out: Chunk[] = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString("latin1");
    const body = png.subarray(at + 8, at + 8 + length);
    out.push({ type, body, crc: png.readUInt32BE(at + 8 + length) });
    at += 12 + length;
  }
  return out;
}

describe("encodePng (ATO-2205)", () => {
  it("writes an RGB image: signature, IHDR, filter-0 rows, IEND, valid CRCs", () => {
    const data = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const png = encodePng({ width: 3, height: 2, channels: 3, bitDepth: 8, data });
    expect([...png.subarray(0, 8)]).toEqual(SIGNATURE);
    const list = chunks(png);
    expect(list.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    const header = list[0]!.body;
    expect(header.readUInt32BE(0)).toBe(3);
    expect(header.readUInt32BE(4)).toBe(2);
    expect(header[8]).toBe(8);
    expect(header[9]).toBe(2);
    for (const c of list) {
      expect(c.crc).toBe(crc32(Buffer.concat([Buffer.from(c.type, "latin1"), c.body])));
    }
    const rows = inflateSync(list[1]!.body);
    expect([...rows]).toEqual([0, ...data.subarray(0, 9), 0, ...data.subarray(9)]);
  });

  it("uses the standard CRC-32 (IEND's CRC is AE426082)", () => {
    expect(crc32(Buffer.from("IEND", "latin1"))).toBe(0xae426082);
    const png = encodePng({ width: 1, height: 1, channels: 1, bitDepth: 8, data: Uint8Array.from([0]) });
    expect(png.subarray(png.length - 4).toString("hex")).toBe("ae426082");
  });

  it("writes 1-bit gray as colour type 0, depth 1, and RGBA as colour type 6", () => {
    const bits = encodePng({ width: 10, height: 1, channels: 1, bitDepth: 1, data: Uint8Array.from([0b10100000, 0b01000000]) });
    const bitsHeader = chunks(bits)[0]!.body;
    expect([bitsHeader[8], bitsHeader[9]]).toEqual([1, 0]);
    expect([...inflateSync(chunks(bits)[1]!.body)]).toEqual([0, 0b10100000, 0b01000000]);
    const rgba = encodePng({ width: 1, height: 1, channels: 4, bitDepth: 8, data: Uint8Array.from([1, 2, 3, 4]) });
    expect(chunks(rgba)[0]!.body[9]).toBe(6);
  });

  it("refuses data shorter than the image size", () => {
    expect(() => encodePng({ width: 4, height: 4, channels: 3, bitDepth: 8, data: new Uint8Array(10) })).toThrow(/too short/);
  });
});
