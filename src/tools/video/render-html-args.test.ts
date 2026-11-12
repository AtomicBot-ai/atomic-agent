import { describe, expect, it } from "vitest";

import {
  RENDER_HTML_DEFAULT_DURATION,
  RENDER_HTML_DEFAULT_FPS,
  RENDER_HTML_DEFAULT_HEIGHT,
  RENDER_HTML_DEFAULT_WIDTH,
  RENDER_HTML_FRAMES_MAX,
  parseRenderHtmlArgs,
} from "./render-html-args.js";

describe("parseRenderHtmlArgs", () => {
  it("fills the defaults for a page file", () => {
    expect(parseRenderHtmlArgs({ path: " intro.html " })).toEqual({
      path: "intro.html",
      duration: RENDER_HTML_DEFAULT_DURATION,
      fps: RENDER_HTML_DEFAULT_FPS,
      width: RENDER_HTML_DEFAULT_WIDTH,
      height: RENDER_HTML_DEFAULT_HEIGHT,
      frames: RENDER_HTML_DEFAULT_DURATION * RENDER_HTML_DEFAULT_FPS,
    });
  });

  it("takes inline markup, a vertical size and an output name", () => {
    const args = parseRenderHtmlArgs({ html: "<h1>hi</h1>", duration: 2.5, fps: 24, width: 1080, height: 1920, output: "teaser.mp4" });
    expect(args).toMatchObject({ html: "<h1>hi</h1>", duration: 2.5, fps: 24, width: 1080, height: 1920, frames: 60, output: "teaser.mp4" });
    expect(args.path).toBeUndefined();
  });

  it("needs exactly one of path and html", () => {
    expect(() => parseRenderHtmlArgs({})).toThrow(/exactly one of `path`/);
    expect(() => parseRenderHtmlArgs({ path: "a.html", html: "<p>" })).toThrow(/exactly one of `path`/);
    expect(() => parseRenderHtmlArgs({ html: 42 })).toThrow(/`html` must be a string/);
  });

  it("refuses a URL, a non-HTML file and a non-mp4 output", () => {
    expect(() => parseRenderHtmlArgs({ path: "https://example.com/a.html" })).toThrow(/not a URL/);
    expect(() => parseRenderHtmlArgs({ path: "notes.txt" })).toThrow(/\.html file/);
    expect(() => parseRenderHtmlArgs({ path: "a.html", output: "a.mov" })).toThrow(/\.mp4/);
  });

  it("bounds duration, fps and size", () => {
    expect(() => parseRenderHtmlArgs({ path: "a.html", duration: 0 })).toThrow(/`duration`/);
    expect(() => parseRenderHtmlArgs({ path: "a.html", duration: 61 })).toThrow(/`duration`/);
    expect(() => parseRenderHtmlArgs({ path: "a.html", fps: 0 })).toThrow(/`fps`/);
    expect(() => parseRenderHtmlArgs({ path: "a.html", fps: 61 })).toThrow(/`fps`/);
    expect(() => parseRenderHtmlArgs({ path: "a.html", fps: 29.97 })).toThrow(/`fps`/);
    expect(() => parseRenderHtmlArgs({ path: "a.html", width: 4000 })).toThrow(/`width`/);
    expect(() => parseRenderHtmlArgs({ path: "a.html", height: 10 })).toThrow(/`height`/);
    expect(() => parseRenderHtmlArgs({ path: "a.html", width: 1920, height: 1920 })).toThrow(/1920×1080 worth of pixels/);
    expect(() => parseRenderHtmlArgs({ path: "a.html", duration: "5" })).toThrow(/`duration`/);
  });

  it("caps the total frame count", () => {
    expect(parseRenderHtmlArgs({ path: "a.html", duration: 60, fps: 30 }).frames).toBe(RENDER_HTML_FRAMES_MAX);
    expect(() => parseRenderHtmlArgs({ path: "a.html", duration: 60, fps: 60 })).toThrow(/over the limit of 1800/);
  });

  it("rounds an odd side down to even for H.264", () => {
    const args = parseRenderHtmlArgs({ path: "a.html", width: 801, height: 601 });
    expect(args.width).toBe(800);
    expect(args.height).toBe(600);
  });
});
