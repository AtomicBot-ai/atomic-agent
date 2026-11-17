import { describe, expect, it } from "vitest";
import {
  chunkBase64,
  encodeKittyDelete,
  encodeKittyTransmit,
  kittyIdColor,
  kittyPlaceholderRows,
  KITTY_CHUNK_SIZE,
} from "./kitty-graphics.js";

const APC_RE = /\u001b_G([^;]*);([^\u001b]*)\u001b\\/g;

function commands(sequence: string): Array<{ keys: string; payload: string }> {
  return [...sequence.matchAll(APC_RE)].map((m) => ({ keys: m[1]!, payload: m[2]! }));
}

describe("encodeKittyTransmit", () => {
  it("sends a small PNG in one quiet chunk with a virtual placement", () => {
    const png = Uint8Array.from([1, 2, 3, 4, 5]);
    const [only, ...rest] = commands(encodeKittyTransmit(png, 42, 10, 5));
    expect(rest).toHaveLength(0);
    expect(only!.keys).toBe("a=T,U=1,f=100,t=d,i=42,c=10,r=5,q=2,m=0");
    expect(Buffer.from(only!.payload, "base64")).toEqual(Buffer.from(png));
  });

  it("chunks large payloads at 4096 and carries keys only on the first", () => {
    const png = new Uint8Array(KITTY_CHUNK_SIZE * 2); // base64 is 4/3 of that
    const parts = commands(encodeKittyTransmit(png, 7, 4, 2));
    expect(parts.length).toBe(3);
    expect(parts[0]!.keys).toContain("a=T");
    expect(parts[0]!.keys.endsWith("m=1")).toBe(true);
    expect(parts[1]!.keys).toBe("m=1,q=2");
    expect(parts[2]!.keys).toBe("m=0,q=2");
    for (const part of parts.slice(0, -1)) expect(part.payload.length).toBe(KITTY_CHUNK_SIZE);
    const joined = parts.map((p) => p.payload).join("");
    expect(Buffer.from(joined, "base64").length).toBe(png.length);
  });

  it("refuses ids and sizes it cannot encode", () => {
    expect(() => encodeKittyTransmit(new Uint8Array(1), 0, 1, 1)).toThrow();
    expect(() => encodeKittyTransmit(new Uint8Array(1), 0x1000000, 1, 1)).toThrow();
    expect(() => encodeKittyTransmit(new Uint8Array(1), 1, 0, 1)).toThrow();
    expect(() => encodeKittyTransmit(new Uint8Array(1), 1, 65, 1)).toThrow();
  });
});

describe("chunkBase64", () => {
  it("keeps every chunk but the last at the full size", () => {
    expect(chunkBase64("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(chunkBase64("")).toEqual([""]);
  });
});

describe("kitty placeholders", () => {
  it("encodes the id as a 24-bit foreground", () => {
    expect(kittyIdColor(0x0a0b0c)).toBe("\u001b[38;2;10;11;12m");
  });

  it("draws one line per row, one cell per column", () => {
    const rows = kittyPlaceholderRows(0x123456, 3, 2);
    expect(rows).toHaveLength(2);
    for (const line of rows) {
      expect(line.startsWith(kittyIdColor(0x123456))).toBe(true);
      expect(line.endsWith("\u001b[39m")).toBe(true);
      expect([...line].filter((ch) => ch.codePointAt(0) === 0x10eeee)).toHaveLength(3);
    }
    // Row 0 / column 1 carries the first row mark and the second column mark.
    const cells = [...rows[0]!.matchAll(/\u{10EEEE}(.)(.)/gu)].map((m) => [
      m[1]!.codePointAt(0),
      m[2]!.codePointAt(0),
    ]);
    expect(cells).toEqual([
      [0x0305, 0x0305],
      [0x0305, 0x030d],
      [0x0305, 0x030e],
    ]);
    expect(rows[1]!.includes("\u{10EEEE}̍̅")).toBe(true);
  });

  it("deletes by id, quietly", () => {
    expect(encodeKittyDelete(9)).toBe("\u001b_Ga=d,d=I,i=9,q=2\u001b\\");
  });
});
