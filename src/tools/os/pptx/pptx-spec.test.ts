import { describe, expect, it } from "vitest";
import { fitInto, sniffImage } from "./pptx-image.js";
import {
  MAX_BULLETS_PER_SLIDE,
  MAX_SLIDES,
  parseAccentColor,
  parseBullet,
  parseDeckSpec,
} from "./pptx-spec.js";

const one = [{ title: "Hello" }];

describe("parseDeckSpec", () => {
  it("reads a minimal deck with the light theme by default", () => {
    const spec = parseDeckSpec({ path: "out/deck.pptx", slides: one });
    expect(spec).toEqual({
      path: "out/deck.pptx",
      slides: [{ title: "Hello", bullets: [] }],
      theme: "light",
      overwrite: false,
    });
  });

  it("treats null and empty optional fields as absent, as strict providers send them", () => {
    const spec = parseDeckSpec({
      path: "deck.pptx",
      slides: [{ title: "A", subtitle: null, bullets: null, image: "", notes: null }],
      theme: null,
      accentColor: "",
      font: null,
      title: "",
      overwrite: null,
    });
    expect(spec.slides[0]).toEqual({ title: "A", bullets: [] });
    expect(spec.theme).toBe("light");
    expect(spec.accentColor).toBeUndefined();
    expect(spec.overwrite).toBe(false);
  });

  it("refuses a path that is not a .pptx file", () => {
    expect(() => parseDeckSpec({ path: "deck.ppt", slides: one })).toThrow(/must end in \.pptx/);
    expect(() => parseDeckSpec({ path: "", slides: one })).toThrow(/path must be a non-empty string/);
  });

  it("refuses an empty or oversized slide list and a slide without a title", () => {
    expect(() => parseDeckSpec({ path: "d.pptx", slides: [] })).toThrow(/non-empty array/);
    const many = Array.from({ length: MAX_SLIDES + 1 }, (_, i) => ({ title: `S${i}` }));
    expect(() => parseDeckSpec({ path: "d.pptx", slides: many })).toThrow(/at most 200 slides/);
    expect(() => parseDeckSpec({ path: "d.pptx", slides: [{ title: "  " }] })).toThrow(/slides\[0\]\.title/);
    expect(() => parseDeckSpec({ path: "d.pptx", slides: ["Hello"] })).toThrow(/slides\[0\] must be an object/);
  });

  it("caps bullets per slide and asks for more slides instead", () => {
    const bullets = Array.from({ length: MAX_BULLETS_PER_SLIDE + 1 }, (_, i) => `b${i}`);
    expect(() => parseDeckSpec({ path: "d.pptx", slides: [{ title: "T", bullets }] })).toThrow(/split it over more slides/);
    expect(() => parseDeckSpec({ path: "d.pptx", slides: [{ title: "T", bullets: [1] }] })).toThrow(/bullets\[0\] must be a string/);
  });

  it("drops blank bullets and keeps the rest in order", () => {
    const spec = parseDeckSpec({ path: "d.pptx", slides: [{ title: "T", bullets: ["a", "   ", "b"] }] });
    expect(spec.slides[0]!.bullets.map((b) => b.text)).toEqual(["a", "b"]);
  });

  it("accepts the four themes case-insensitively and refuses others", () => {
    expect(parseDeckSpec({ path: "d.pptx", slides: one, theme: "Dark" }).theme).toBe("dark");
    expect(() => parseDeckSpec({ path: "d.pptx", slides: one, theme: "neon" })).toThrow(/theme must be one of light, dark, blue, warm/);
  });
});

describe("parseBullet", () => {
  it("reads two leading spaces (or a tab) per level and strips list markers", () => {
    expect(parseBullet("Top")).toEqual({ text: "Top", level: 0 });
    expect(parseBullet("  - Sub")).toEqual({ text: "Sub", level: 1 });
    expect(parseBullet("\t\t• Deeper")).toEqual({ text: "Deeper", level: 2 });
    expect(parseBullet(" ".repeat(20) + "Deepest")).toEqual({ text: "Deepest", level: 4 });
  });
});

describe("parseAccentColor", () => {
  it("normalises 3- and 6-digit hex with or without #", () => {
    expect(parseAccentColor("#2f6feb")).toBe("2F6FEB");
    expect(parseAccentColor("f80")).toBe("FF8800");
    expect(() => parseAccentColor("blue")).toThrow(/hex colour/);
  });
});

describe("sniffImage", () => {
  it("reads PNG, GIF and JPEG sizes from their headers", () => {
    const png = Buffer.alloc(24);
    png[0] = 0x89;
    png.write("PNG", 1, "ascii");
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    expect(sniffImage(png)).toEqual({ kind: "png", width: 640, height: 480 });

    const gif = Buffer.alloc(10);
    gif.write("GIF89a", 0, "ascii");
    gif.writeUInt16LE(32, 6);
    gif.writeUInt16LE(16, 8);
    expect(sniffImage(gif)).toEqual({ kind: "gif", width: 32, height: 16 });

    // SOI, an APP0 segment, then a baseline SOF0 frame header.
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03,
      0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(sniffImage(jpeg)).toEqual({ kind: "jpeg", width: 400, height: 300 });
  });

  it("returns null for anything else", () => {
    expect(sniffImage(Buffer.from("not a picture at all"))).toBeNull();
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });
});

describe("fitInto", () => {
  it("keeps the aspect ratio and centres the picture in its box", () => {
    expect(fitInto({ width: 200, height: 100 }, { x: 0, y: 0, cx: 100, cy: 100 })).toEqual({ x: 0, y: 25, cx: 100, cy: 50 });
  });
});
