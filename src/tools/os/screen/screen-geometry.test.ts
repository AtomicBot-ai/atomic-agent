import { describe, expect, it } from "vitest";
import {
  captureGeometry,
  fitWithin,
  ScreenGeometryStore,
  toScreenPoint,
  type CaptureGeometry,
} from "./screen-geometry.js";
import { parseKeyChord } from "./screen-keys.js";

const retinaFull: CaptureGeometry = captureGeometry(
  { x: 0, y: 0, width: 1440, height: 900 },
  { width: 1280, height: 800 },
);

describe("screenshot ↔ screen point mapping", () => {
  it("downscales only past the long-side cap, keeping the aspect ratio", () => {
    expect(fitWithin(2880, 1800)).toEqual({ width: 1280, height: 800, resize: true });
    expect(fitWithin(1800, 2880)).toEqual({ width: 800, height: 1280, resize: true });
    expect(fitWithin(1024, 768)).toEqual({ width: 1024, height: 768, resize: false });
  });

  it("maps image pixels back through the remembered capture", () => {
    expect(retinaFull.scale).toBeCloseTo(0.8889, 4);
    expect(toScreenPoint(640, 400, retinaFull)).toMatchObject({ x: 720, y: 450 });
    expect(toScreenPoint(0, 0, retinaFull)).toMatchObject({ x: 0, y: 0 });
    expect(toScreenPoint(1280, 800, retinaFull)).toMatchObject({ x: 1440, y: 900 });
  });

  it("adds a region's origin", () => {
    const region = captureGeometry({ x: 100, y: 50, width: 400, height: 300 }, { width: 800, height: 600 });
    expect(toScreenPoint(200, 100, region)).toMatchObject({ x: 200, y: 100, scale: 2, originX: 100, originY: 50 });
    // Echoing the capture's own scale keeps its origin.
    expect(toScreenPoint(200, 100, region, 2)).toMatchObject({ x: 200, y: 100 });
  });

  it("treats a different explicit scale as a full-screen image, and no capture as points", () => {
    expect(toScreenPoint(100, 100, retinaFull, 2)).toMatchObject({ x: 50, y: 50, originX: 0 });
    expect(toScreenPoint(100, 100, undefined)).toMatchObject({ x: 100, y: 100, scale: 1 });
    expect(toScreenPoint(100, 100, undefined, 0.5)).toMatchObject({ x: 200, y: 200 });
  });

  it("keeps the newest capture per session and forgets the oldest sessions", () => {
    const store = new ScreenGeometryStore(2);
    store.set("a", retinaFull);
    store.set("b", retinaFull);
    store.set("c", retinaFull);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("c")).toBe(retinaFull);
  });
});

describe("key chords", () => {
  it("maps names, letters and modifiers to key codes and flags", () => {
    expect(parseKeyChord("return")).toEqual({ keyCode: 36, flags: 0, label: "return" });
    expect(parseKeyChord("Escape")).toMatchObject({ keyCode: 53, flags: 0 });
    expect(parseKeyChord("down")).toMatchObject({ keyCode: 125 });
    expect(parseKeyChord("cmd+l")).toEqual({ keyCode: 37, flags: 0x100000, label: "cmd+l" });
    expect(parseKeyChord("command + option + esc")).toMatchObject({ keyCode: 53, flags: 0x100000 | 0x80000, label: "alt+cmd+esc" });
    expect(parseKeyChord("ctrl+shift+tab")).toMatchObject({ keyCode: 48, flags: 0x40000 | 0x20000 });
    expect(parseKeyChord("f12")).toMatchObject({ keyCode: 111 });
    expect(parseKeyChord("cmd+,")).toMatchObject({ keyCode: 43 });
  });

  it("refuses what it cannot press", () => {
    expect(() => parseKeyChord("")).toThrow(/must name a key/);
    expect(() => parseKeyChord("cmd+")).toThrow(/empty part/);
    expect(() => parseKeyChord("hyper+q")).toThrow(/unknown modifier/);
    expect(() => parseKeyChord("cmd+enterprise")).toThrow(/unknown key/);
  });
});
