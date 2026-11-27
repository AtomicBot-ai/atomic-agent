/**
 * ATO-2410: a .pptx deck's slides drawn by a program the machine has
 * (slide-render-plan.ts says which and how), for the preview panel.
 *
 * `renderSlides(real)` is asked by main's `app:filePreviewSlides` after the
 * panel has already shown the deck's text cards (file-preview.ts); the panel
 * swaps them for the pictures when this answers. The path has passed the
 * preview's own root check before it gets here; this still converts only a
 * file whose extension and first bytes say it is a deck.
 *
 * The converter writes into a fresh temporary folder that is removed after
 * the output has been read within its cap; it never writes beside the deck.
 * Conversions run one at a time (LibreOffice locks its profile), and the
 * result for one version of a file (path, size, mtime) is kept in a small
 * cache, so the panel's poll and a reopen do not convert again. LibreOffice
 * is skipped for a deck whose parts link outside the file (a picture, video or
 * object with TargetMode="External"), so it is never asked to fetch one; such
 * a deck goes to Quick Look on a Mac, or keeps its text cards. PowerPoint on
 * Windows (ATO-2517) follows LibreOffice under the same rule. A failed
 * conversion is cached too, until the panel's Reload asks to try again.
 *
 * Pure but for the file system and the child process, both injectable: no
 * Electron import, so the unit suite loads it from `out/main` with a stub
 * `run` that writes what the real program would.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { sniffImageMime } from "./image-data-url.js";
import { looksZip, OFFICE_LIMITS, OFFICE_MAX_FILE_BYTES, openZip } from "./office-preview.js";
import type { Platform } from "./platform.js";
import {
  converterPlans, deckHasCharts, deckLinksOut, findSoffice, inlineAttachments, isAttachmentName, pickOutput, quickLookWidth,
  SLIDES_HTML_MAX_BYTES, SLIDES_IMAGE_MAX_BYTES, SLIDES_IMAGES_TOTAL_MAX_BYTES, SLIDES_PDF_MAX_BYTES,
  slidesRenderableWith, sofficeCandidates, type SlideConverter, type SlideRender,
} from "./slide-render-plan.js";
import { POWERPOINT_PDF_NAME, powerPointCandidates, powerPointPlan, powerShellPath } from "./slide-render-powerpoint.js";

export type RunResult = { ok: boolean };
export type SlideRenderDeps = {
  env: NodeJS.ProcessEnv;
  home: string;
  /** The folder temporary output goes under. */
  tmp: string;
  exists: (p: string) => boolean;
  /** Runs one converter; resolves `{ok:false}` (never throws) when it fails or times out. */
  run: (command: string, args: string[], timeoutMs: number) => Promise<RunResult>;
};

function runProcess(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error) => resolve({ ok: !error }));
    } catch {
      resolve({ ok: false });
    }
  });
}

const DEFAULT_DEPS: SlideRenderDeps = {
  env: process.env, home: homedir(), tmp: tmpdir(), exists: existsSync, run: runProcess,
};

function sofficeFor(platform: Platform, d: SlideRenderDeps): string | null {
  return findSoffice(sofficeCandidates(platform, d.env, d.home), d.exists);
}

/** ATO-2517: PowerShell and PowerPoint on Windows, when both are there; null elsewhere. */
function powerPointFor(platform: Platform, d: SlideRenderDeps): { powershell: string; app: string } | null {
  if (platform !== "win32") return null;
  const powershell = powerShellPath(d.env);
  const app = findSoffice(powerPointCandidates(d.env), d.exists);   // the same "first that exists"
  if (!app) return null;
  try { return d.exists(powershell) ? { powershell, app } : null; } catch { return null; }
}

/** Whether a deck previewed on this machine can be drawn at all (the panel asks for the pictures only then). */
export function slidesRenderable(platform: Platform, deps: Partial<SlideRenderDeps> = {}): boolean {
  const d = { ...DEFAULT_DEPS, ...deps };
  return slidesRenderableWith(platform, sofficeFor(platform, d), d.exists, powerPointFor(platform, d) !== null);
}

/** A file whose size is known and under `max`, read whole; null otherwise. */
async function readCapped(path: string, max: number): Promise<Buffer | null> {
  const st = await stat(path).catch(() => null);
  if (!st || !st.isFile() || st.size > max) return null;
  return readFile(path).catch(() => null);
}

async function collectPdf(outDir: string, name: string): Promise<SlideRender | null> {
  const bytes = await readCapped(join(outDir, name), SLIDES_PDF_MAX_BYTES);
  if (!bytes || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return null;
  return { kind: "pdf", base64: bytes.toString("base64") };
}

async function collectQuickLook(outDir: string, name: string): Promise<SlideRender | null> {
  const dir = join(outDir, name);
  const page = await readCapped(join(dir, "Preview.html"), SLIDES_HTML_MAX_BYTES);
  if (!page) return null;
  const plist = await readCapped(join(dir, "PreviewProperties.plist"), 1024 * 1024);
  const pictures = new Map<string, string>();
  let total = 0;
  for (const entry of (await readdir(dir).catch(() => [] as string[])).filter(isAttachmentName).sort()) {
    const bytes = await readCapped(join(dir, entry), Math.min(SLIDES_IMAGE_MAX_BYTES, SLIDES_IMAGES_TOTAL_MAX_BYTES - total));
    if (!bytes) continue;
    const mime = sniffImageMime(bytes.subarray(0, 16));
    if (!mime) continue;   // only a picture by its bytes, never SVG
    total += bytes.length;
    pictures.set(entry, `data:${mime};base64,${bytes.toString("base64")}`);
  }
  return { kind: "html", html: inlineAttachments(page.toString("utf8"), pictures), width: quickLookWidth(plist ? plist.toString("utf8") : "") };
}

async function tryPlan(plan: SlideConverter, outDir: string, d: SlideRenderDeps, charts: boolean): Promise<SlideRender | null> {
  const ran = await d.run(plan.command, plan.args, plan.timeoutMs);
  if (!ran.ok) return null;
  const out = pickOutput(plan.kind, await readdir(outDir).catch(() => [] as string[]));
  if (!out) return null;
  if (plan.kind !== "quicklook") return collectPdf(outDir, out);
  const page = await collectQuickLook(outDir, out);
  return page && page.kind === "html" && charts ? { ...page, charts: true } : page;
}

async function isDeck(real: string): Promise<boolean> {
  if (!/\.pptx$/i.test(real)) return false;
  const fh = await open(real, "r").catch(() => null);
  if (!fh) return false;
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await fh.read(head, 0, 4, 0);
    return looksZip(head.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/**
 * Whether the deck at `real` links outside itself (or cannot be read to
 * tell): then neither LibreOffice nor PowerPoint is asked. And whether it has
 * charts (Quick Look leaves them out).
 */
async function deckFacts(real: string): Promise<{ linksOut: boolean; charts: boolean }> {
  const bytes = await readCapped(real, OFFICE_MAX_FILE_BYTES);
  const zip = bytes ? openZip(bytes) : null;
  return { linksOut: !bytes || deckLinksOut(zip, OFFICE_LIMITS.entries), charts: deckHasCharts(zip) };
}

async function convert(real: string, platform: Platform, d: SlideRenderDeps): Promise<SlideRender | null> {
  if (!(await isDeck(real))) return null;
  const facts = await deckFacts(real);
  const soffice = facts.linksOut ? null : sofficeFor(platform, d);
  const powerpoint = facts.linksOut ? null : powerPointFor(platform, d);
  const profile = join(d.tmp, "atomic-agent-soffice-profile");   // kept between runs: a fresh one costs LibreOffice seconds
  const outDir = await mkdtemp(join(d.tmp, "atomic-agent-slides-")).catch(() => null);
  if (!outDir) return null;
  try {
    const plans = converterPlans(platform, real, outDir, pathToFileURL(profile).href, soffice);
    // ATO-2517: PowerPoint after LibreOffice on Windows.
    const pp = powerpoint ? powerPointPlan(powerpoint.powershell, real, join(outDir, POWERPOINT_PDF_NAME)) : null;
    if (pp) plans.push(pp);
    for (const plan of plans) {
      const got = await tryPlan(plan, outDir, d, facts.charts).catch(() => null);
      if (got) return got;
      // The next converter gets an empty folder, so its output is not mistaken for the first one's.
      for (const n of await readdir(outDir).catch(() => [] as string[])) await rm(join(outDir, n), { recursive: true, force: true }).catch(() => undefined);
    }
    return null;
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const CACHE_MAX = 8;
const cache = new Map<string, Promise<SlideRender | null>>();
/** ATO-2517: the cached versions whose conversion gave nothing; a retry converts those again. */
const failed = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

/**
 * The slides of the deck at `real` (a path the preview's root check passed),
 * or null when nothing on this machine can draw them, the conversion failed
 * or its output is over a cap. One version of a file is converted once; a
 * failed one again only when `retry` says so (the panel's Reload, ATO-2517),
 * so the poll and a reopen never start a slow converter over and over.
 */
export function renderSlides(
  real: string,
  platform: Platform,
  deps: Partial<SlideRenderDeps> = {},
  opts: { retry?: boolean } = {},
): Promise<SlideRender | null> {
  const d = { ...DEFAULT_DEPS, ...deps };
  return stat(real).then((st) => {
    if (!st.isFile()) return null;
    const key = `${real}\0${st.size}\0${st.mtimeMs}`;
    if (opts.retry === true && failed.delete(key)) cache.delete(key);
    const hit = cache.get(key);
    if (hit) return hit;
    // One converter at a time, failures included: the next waits for this one whatever happens.
    const job = queue.then(() => convert(real, platform, d), () => convert(real, platform, d)).catch(() => null);
    queue = job;
    cache.set(key, job);
    void job.then((r) => { if (r === null && cache.get(key) === job) failed.add(key); });
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
      failed.delete(oldest);
    }
    return job;
  }, () => null);
}
