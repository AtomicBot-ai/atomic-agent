#!/usr/bin/env node
// Fallback renderer for the motion templates: capture every frame of a
// template with headless Chrome and join them into an MP4 with ffmpeg.
// Used only when the agent has no HTML-to-MP4 tool of its own.
//
// Usage:
//   node render-frames.mjs <template.html | release | big-number | logo-reveal> <out.mp4>
//        [--params "version=v0.7.0&headline=..."] [--fps 30] [--w 1920] [--h 1080]
//        [--duration 6] [--keep-frames]
//
// Frames are taken in one of two ways, the first that works:
//   1. playwright or playwright-core, if it can be imported: one browser,
//      window.__setTime(t) before each screenshot (fast);
//   2. the installed Chrome (or Chromium, Edge) driven over the DevTools
//      protocol: one headless browser, the same window.__setTime(t) per frame.
//      Needs only Node 22+ (global WebSocket), no npm packages.
// CHROME_PATH overrides the browser binary, FFMPEG_PATH the ffmpeg binary.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES = ["release", "big-number", "logo-reveal"];

export function parseArgs(argv) {
  const opts = { fps: 30, w: 1920, h: 1080, params: "", keepFrames: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--params") opts.params = next();
    else if (a === "--fps") opts.fps = Number(next());
    else if (a === "--w") opts.w = Number(next());
    else if (a === "--h") opts.h = Number(next());
    else if (a === "--duration") opts.duration = Number(next());
    else if (a === "--keep-frames") opts.keepFrames = true;
    else rest.push(a);
  }
  if (rest.length !== 2) throw new Error("usage: render-frames.mjs <template> <out.mp4> [options]");
  [opts.template, opts.out] = rest;
  for (const k of ["fps", "w", "h"]) {
    if (!Number.isFinite(opts[k]) || opts[k] <= 0) throw new Error(`--${k} must be a positive number`);
  }
  return opts;
}

export function resolveTemplate(name) {
  if (TEMPLATES.includes(name)) return join(HERE, "..", "templates", `${name}.html`);
  return resolve(name);
}

/** `<meta name="motion:duration" content="6">` in the template, in seconds. */
export function readDuration(html) {
  const m = html.match(/<meta\s+name="motion:duration"\s+content="([\d.]+)"/);
  return m ? Number(m[1]) : null;
}

/** Times of every frame, from 0 up to and including the last frame before `duration`. */
export function frameTimes(duration, fps) {
  const count = Math.max(1, Math.round(duration * fps));
  return Array.from({ length: count }, (_, i) => Number((i / fps).toFixed(4)));
}

export function frameUrl(templatePath, params, t, w, h) {
  const q = new URLSearchParams(params);
  q.set("w", String(w));
  q.set("h", String(h));
  if (t !== undefined) q.set("t", String(t));
  return `${pathToFileURL(templatePath).href}?${q.toString()}`;
}

export function ffmpegArgs(framesDir, fps, out) {
  return [
    "-y", "-framerate", String(fps),
    "-i", join(framesDir, "frame_%05d.png"),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
    "-movflags", "+faststart",
    out,
  ];
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    win32: [
      `${process.env["PROGRAMFILES"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["LOCALAPPDATA"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ],
    linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"],
  }[process.platform] ?? [];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    child.on("error", rej);
    child.on("close", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}: ${err.trim()}`))));
  });
}

async function loadPlaywright() {
  for (const name of ["playwright", "playwright-core"]) {
    try {
      const mod = await import(name);
      return mod.chromium ?? mod.default?.chromium ?? null;
    } catch {
      // try the next one
    }
  }
  return null;
}

async function captureWithPlaywright(chromium, chrome, opts, templatePath, times, framesDir) {
  const browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
  try {
    const page = await browser.newPage({ viewport: { width: opts.w, height: opts.h }, deviceScaleFactor: 1 });
    await page.goto(frameUrl(templatePath, `${opts.params}&autoplay=0`, undefined, opts.w, opts.h));
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
    for (let i = 0; i < times.length; i++) {
      await page.evaluate((t) => window.__setTime(t), times[i]);
      await page.screenshot({ path: join(framesDir, `frame_${String(i + 1).padStart(5, "0")}.png`) });
    }
  } finally {
    await browser.close();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Minimal DevTools-protocol client over the global WebSocket (Node 22+). */
function cdpClient(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(`${msg.error.message} (${msg.error.code})`));
        else ok(msg.result);
      } else if (msg.method) {
        for (const l of listeners) l(msg);
      }
    };
    ws.onerror = () => rej(new Error("cannot connect to Chrome DevTools"));
    ws.onopen = () =>
      res({
        send(method, params = {}, sessionId) {
          const msgId = ++id;
          ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
          return new Promise((ok, fail) => pending.set(msgId, { resolve: ok, reject: fail }));
        },
        on(fn) {
          listeners.push(fn);
        },
        close() {
          ws.close();
        },
      });
  });
}

async function captureWithChromeCdp(chrome, opts, templatePath, times, framesDir) {
  if (typeof WebSocket === "undefined") throw new Error("this Node has no WebSocket; use Node 22 or newer, or install playwright");
  const profile = mkdtempSync(join(tmpdir(), "motion-chrome-"));
  const child = spawn(chrome, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--allow-file-access-from-files", "--force-device-scale-factor=1",
    `--user-data-dir=${profile}`, `--window-size=${opts.w},${opts.h}`,
    "--remote-debugging-port=0", "about:blank",
  ], { stdio: "ignore" });
  let client;
  try {
    const portFile = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(100);
    if (!existsSync(portFile)) throw new Error("Chrome did not start (no DevToolsActivePort after 15 s)");
    const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
    client = await cdpClient(`ws://127.0.0.1:${port}${path}`);
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, params) => client.send(method, params, sessionId);
    await send("Emulation.setDeviceMetricsOverride", { width: opts.w, height: opts.h, deviceScaleFactor: 1, mobile: false });
    await send("Page.enable");
    const loaded = new Promise((r) => client.on((m) => m.method === "Page.loadEventFired" && m.sessionId === sessionId && r()));
    await send("Page.navigate", { url: frameUrl(templatePath, `${opts.params}&autoplay=0`, undefined, opts.w, opts.h) });
    await loaded;
    const evaluate = async (expression) =>
      (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
    for (let i = 0; i < 150 && (await evaluate("window.__ready === true")) !== true; i++) await sleep(100);
    if ((await evaluate("typeof window.__setTime")) !== "function") throw new Error("the template has no window.__setTime(t)");
    for (let i = 0; i < times.length; i++) {
      await evaluate(`new Promise((r) => { window.__setTime(${times[i]}); requestAnimationFrame(() => requestAnimationFrame(() => r(true))); })`);
      const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true, optimizeForSpeed: true });
      writeFileSync(join(framesDir, `frame_${String(i + 1).padStart(5, "0")}.png`), Buffer.from(shot.data, "base64"));
      if ((i + 1) % 30 === 0) process.stdout.write(`frames: ${i + 1}/${times.length}\n`);
    }
    await client.send("Browser.close").catch(() => {});
  } finally {
    client?.close();
    const exited = new Promise((r) => child.once("exit", r));
    if (child.exitCode === null) child.kill();
    await Promise.race([exited, sleep(3000)]);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // a leftover temp profile is harmless
    }
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  const templatePath = resolveTemplate(opts.template);
  if (!existsSync(templatePath)) throw new Error(`template not found: ${templatePath}`);
  const duration = opts.duration ?? readDuration(readFileSync(templatePath, "utf8"));
  if (!duration) throw new Error("no duration: pass --duration or add <meta name=\"motion:duration\">");
  const times = frameTimes(duration, opts.fps);
  const chrome = findChrome();
  const framesDir = mkdtempSync(join(tmpdir(), "motion-frames-"));
  try {
    const chromium = await loadPlaywright();
    if (chromium) {
      process.stdout.write(`capturing ${times.length} frames with playwright\n`);
      await captureWithPlaywright(chromium, chrome, opts, templatePath, times, framesDir);
    } else {
      if (!chrome) throw new Error("no Chrome, Chromium or Edge found; set CHROME_PATH");
      process.stdout.write(`capturing ${times.length} frames with ${chrome}\n`);
      await captureWithChromeCdp(chrome, opts, templatePath, times, framesDir);
    }
    await run(process.env.FFMPEG_PATH || "ffmpeg", ffmpegArgs(framesDir, opts.fps, resolve(opts.out)));
    process.stdout.write(`video: ${resolve(opts.out)} (${duration}s, ${opts.fps} fps, ${opts.w}x${opts.h})\n`);
    if (opts.keepFrames) process.stdout.write(`frames kept in ${framesDir}\n`);
  } finally {
    if (!opts.keepFrames) rmSync(framesDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
