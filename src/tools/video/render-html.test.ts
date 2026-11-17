import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolContext } from "../tool-registry.js";
import { FFMPEG_MISSING, type SpawnFn } from "./render-html-ffmpeg.js";
import type { CaptureFramesInput } from "./render-html-frames.js";
import { buildRenderHtmlTool, noBrowserMessage, type RenderHtmlToolOptions } from "./render-html.js";

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "render-html-"));
  writeFileSync(join(work, "intro.html"), "<h1>hi</h1>");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const ctx = (signal = new AbortController().signal): ToolContext => ({ workingDir: work, sessionId: "s1", stepIndex: 0, signal });

/**
 * ffmpeg as the tool sees it: `-version` answers 0; an encode collects
 * stdin, writes the output file when stdin closes, then exits `encodeExit`.
 */
function fakeFfmpeg(opts: { missing?: boolean; encodeExit?: number } = {}) {
  const frames: Buffer[] = [];
  const calls: string[][] = [];
  const spawn = vi.fn<SpawnFn>((_cmd, args) => {
    calls.push([...args]);
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    Object.assign(child, { stdin, stderr: new PassThrough(), kill: vi.fn(() => true) });
    if (opts.missing) {
      setImmediate(() => child.emit("error", Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" })));
      return child;
    }
    if (args[0] === "-version") {
      setImmediate(() => child.emit("close", 0, null));
      return child;
    }
    stdin.on("data", (chunk: Buffer) => frames.push(chunk));
    stdin.on("end", () => {
      writeFileSync(String(args.at(-1)), "mp4");
      child.emit("close", opts.encodeExit ?? 0, null);
    });
    return child;
  });
  return { spawn, frames, calls };
}

/** A capture that hands `frames` fake PNGs to the encoder, without a browser. */
function fakeCapture(over: { fail?: Error; launch?: boolean } = {}) {
  const seen: CaptureFramesInput[] = [];
  const capture = vi.fn(async (input: CaptureFramesInput) => {
    seen.push(input);
    // The tool's own launch wrapper, around `launchBrowser`.
    if (over.launch) await input.launch();
    for (let i = 0; i < input.frames; i++) {
      if (over.fail && i === 1) throw over.fail;
      await input.onFrame(Buffer.from(`f${i}`), i);
    }
    return { pageErrors: [] };
  });
  return { capture, seen };
}

function tool(over: Partial<RenderHtmlToolOptions> = {}) {
  const request = vi.fn(async () => ({ approved: true }));
  const built = buildRenderHtmlTool({
    approvals: { request } as never,
    approvalRequired: true,
    now: () => new Date(2026, 10, 12, 9, 5, 7),
    launchBrowser: async () => { throw new Error("no browser in unit tests"); },
    ...over,
  });
  return { built, request };
}

describe("video.render_html", () => {
  it("records every frame into ffmpeg and saves a fresh .mp4 in the working folder", async () => {
    const ff = fakeFfmpeg();
    const cap = fakeCapture();
    const { built, request } = tool({ spawn: ff.spawn, capture: cap.capture });
    const result = await built.run({ path: "intro.html", duration: 0.5, fps: 10, width: 640, height: 360 }, ctx());

    expect(result.status).toBe("ok");
    const out = join(work, "video-html-20261112-090507.mp4");
    expect(result.details.paths).toEqual([out]);
    expect(existsSync(out)).toBe(true);
    expect(result.summary).toContain("reply.attachments");
    expect(Buffer.concat(ff.frames).toString()).toBe("f0f1f2f3f4");
    expect(cap.seen[0]).toMatchObject({ width: 640, height: 360, fps: 10, frames: 5, source: { kind: "file" } });
    expect(String((cap.seen[0]!.source as { url: string }).url)).toMatch(/^file:.*intro\.html$/);
    expect(ff.calls[0]).toEqual(["-version"]);
    expect(ff.calls[1]?.at(-1)).toBe(out);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "video.render_html", category: "fs_write_workspace", affectedResources: [out], targetPaths: [out] }),
      expect.anything(),
    );
  });

  it("takes inline html and an output name, and never overwrites a file", async () => {
    const ff = fakeFfmpeg();
    const cap = fakeCapture();
    const { built } = tool({ spawn: ff.spawn, capture: cap.capture });
    const ok = await built.run({ html: "<p>x</p>", duration: 0.1, fps: 10, output: "clip.mp4" }, ctx());
    expect(ok.status).toBe("ok");
    expect(cap.seen[0]?.source).toEqual({ kind: "html", html: "<p>x</p>" });
    const again = await built.run({ html: "<p>x</p>", duration: 0.1, fps: 10, output: "clip.mp4" }, ctx());
    expect(again.status).toBe("error");
    expect(again.summary).toMatch(/already exists/);
  });

  it("refuses bad arguments, a missing page and an output outside the working folder before anything starts", async () => {
    const ff = fakeFfmpeg();
    const { built, request } = tool({ spawn: ff.spawn });
    expect((await built.run({ path: "intro.html", fps: 500 }, ctx())).summary).toMatch(/`fps`/);
    expect((await built.run({ path: "missing.html" }, ctx())).summary).toMatch(/no such file/);
    expect((await built.run({ path: "intro.html", output: "../escape.mp4" }, ctx())).summary).toMatch(/inside the working folder/);
    expect(ff.spawn).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("says how to install ffmpeg when it is missing, before asking or launching", async () => {
    const ff = fakeFfmpeg({ missing: true });
    const cap = fakeCapture();
    const { built, request } = tool({ spawn: ff.spawn, capture: cap.capture });
    const result = await built.run({ path: "intro.html" }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain(FFMPEG_MISSING);
    expect(result.details.code).toBe("FFMPEG_MISSING");
    expect(request).not.toHaveBeenCalled();
    expect(cap.capture).not.toHaveBeenCalled();
  });

  it("says how to get a browser when none launches, and leaves no file behind", async () => {
    const ff = fakeFfmpeg();
    const cap = fakeCapture({ launch: true });
    const { built } = tool({
      spawn: ff.spawn,
      capture: cap.capture,
      launchBrowser: async () => { throw new Error("no browser available: no Chromium-family browser found (Chrome, Edge, Brave, Chromium)"); },
    });
    const result = await built.run({ path: "intro.html", duration: 0.1, fps: 10 }, ctx());
    expect(result.status).toBe("error");
    expect(result.details.code).toBe("NO_BROWSER");
    expect(result.summary).toMatch(/no Chromium-family browser found/);
    expect(result.summary).toMatch(/Install Google Chrome/);
    expect(existsSync(join(work, "video-html-20261112-090507.mp4"))).toBe(false);
  });

  it("names a missing playwright-core instead of asking for Chrome", () => {
    expect(noBrowserMessage(new Error("Cannot find package 'playwright-core' imported from /x"))).toMatch(/Playwright \(playwright-core\) is missing/);
    expect(noBrowserMessage(new Error("spawn failed"))).toBe(
      "no browser available: spawn failed. Install Google Chrome (or Chromium, Edge or Brave), or set `browser.executablePath` in the config, then call video.render_html again.",
    );
  });

  it("reports a failed page and removes the half-written file", async () => {
    const ff = fakeFfmpeg();
    const cap = fakeCapture({ fail: new Error("the page did not load: net::ERR_FILE_NOT_FOUND") });
    const { built } = tool({ spawn: ff.spawn, capture: cap.capture });
    const result = await built.run({ path: "intro.html", duration: 0.5, fps: 10 }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/did not load/);
    expect(existsSync(join(work, "video-html-20261112-090507.mp4"))).toBe(false);
  });

  it("asks as trust_config when the output lands on one of the agent's own paths", async () => {
    const ff = fakeFfmpeg();
    const { built, request } = tool({ spawn: ff.spawn, capture: fakeCapture().capture, trustConfigPaths: () => [`${work}/`] });
    await built.run({ path: "intro.html", duration: 0.1, fps: 10 }, ctx());
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ category: "trust_config" }), expect.anything());
  });
});
