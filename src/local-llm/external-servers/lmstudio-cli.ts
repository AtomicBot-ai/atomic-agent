/**
 * LM Studio through its own CLI, `lms` (ATO-2490). LM Studio's REST server
 * lists models but has no route to load, unload or download one; `lms`
 * does all three, and it is what LM Studio's docs point scripts at:
 *
 *   lms server start        start the local server (and LM Studio's service)
 *   lms load <key> --yes    load a downloaded model into memory
 *   lms unload <key>|--all  free its memory
 *   lms get <key> --yes     download a model
 *   lms ls --json           downloaded models, with their files
 *
 * The binary is found where LM Studio installs it for its user
 * (`external-server-paths.ts`), then on PATH. Every run is argument-array
 * spawn, never a shell line, so a model key cannot become a command.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  currentHost,
  findOnPath,
  firstExisting,
  lmsBinaryCandidates,
  type HostPaths,
} from "./external-server-paths.js";

export class LmStudioError extends Error {
  constructor(message: string, readonly detail: string | null = null) {
    super(message);
    this.name = "LmStudioError";
  }
}

export const LMS_MISSING =
  "LM Studio's command line tool (lms) was not found. Open LM Studio once, or run its 'lms bootstrap', then try again.";

export interface LmsRunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `lms` with an argument array. `onLine` sees stdout and stderr lines as they come. */
export type LmsRunner = (
  bin: string,
  args: readonly string[],
  opts: { timeoutMs: number; signal?: AbortSignal; onLine?: (line: string) => void },
) => Promise<LmsRunResult>;

/** A model key as LM Studio prints it (`qwen/qwen3-8b`, `lmstudio-community/...@q4_k_m`). */
export function isLmsModelKey(key: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/.test(key);
}

export function findLmsBinary(
  host: HostPaths = currentHost(),
  exists: (path: string) => boolean = existsSync,
): string | null {
  return firstExisting(lmsBinaryCandidates(host), exists) ?? findOnPath("lms", host, exists);
}

/** Strip the colour codes and carriage-return redraws a progress bar prints. */
export function plainLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").split("\r").pop()!.trim();
}

export const defaultLmsRunner: LmsRunner = (bin, args, opts) =>
  new Promise((resolveRun) => {
    const child = spawn(bin, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal: opts.signal,
    });
    let stdout = "";
    let stderr = "";
    let tail = "";
    const feed = (chunk: Buffer, isErr: boolean) => {
      const text = chunk.toString("utf8");
      if (isErr) stderr += text;
      else stdout += text;
      if (!opts.onLine) return;
      tail += text;
      const parts = tail.split(/\n/);
      tail = parts.pop() ?? "";
      for (const p of parts) {
        const clean = plainLine(p);
        if (clean) opts.onLine(clean);
      }
    };
    const timer = setTimeout(() => child.kill(), opts.timeoutMs);
    child.stdout?.on("data", (c: Buffer) => feed(c, false));
    child.stderr?.on("data", (c: Buffer) => feed(c, true));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({ code: null, stdout, stderr: stderr || err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (opts.onLine && plainLine(tail)) opts.onLine(plainLine(tail));
      resolveRun({ code, stdout, stderr });
    });
  });

export interface LmsOptions {
  readonly bin?: string | null;
  readonly run?: LmsRunner;
  readonly signal?: AbortSignal;
  readonly onLine?: (line: string) => void;
}

async function lms(args: readonly string[], what: string, opts: LmsOptions, timeoutMs: number): Promise<LmsRunResult> {
  const bin = opts.bin === undefined ? findLmsBinary() : opts.bin;
  if (!bin) throw new LmStudioError(LMS_MISSING);
  const res = await (opts.run ?? defaultLmsRunner)(bin, args, {
    timeoutMs,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onLine ? { onLine: opts.onLine } : {}),
  });
  if (res.code !== 0) {
    const detail = plainLine(res.stderr || res.stdout).slice(0, 2000) || null;
    throw new LmStudioError(`LM Studio could not ${what}.`, detail);
  }
  return res;
}

function requireKey(key: string): void {
  if (!isLmsModelKey(key)) throw new LmStudioError(`That is not an LM Studio model name: ${JSON.stringify(key)}`);
}

export async function lmsServerStart(opts: LmsOptions = {}): Promise<void> {
  await lms(["server", "start"], "start its server", opts, 90_000);
}

export async function lmsLoad(key: string, opts: LmsOptions = {}): Promise<void> {
  requireKey(key);
  await lms(["load", key, "--yes"], `load ${key}`, opts, 10 * 60_000);
}

/** `key` null unloads every model. */
export async function lmsUnload(key: string | null, opts: LmsOptions = {}): Promise<void> {
  if (key !== null) requireKey(key);
  await lms(key === null ? ["unload", "--all"] : ["unload", key], key === null ? "unload its models" : `unload ${key}`, opts, 60_000);
}

export async function lmsGet(key: string, opts: LmsOptions = {}): Promise<void> {
  requireKey(key);
  await lms(["get", key, "--yes"], `download ${key}`, opts, 6 * 60 * 60_000);
}

export interface LmsListedModel {
  readonly modelKey: string;
  /** Absolute path of the model file, when `lms ls --json` gave one. */
  readonly path: string | null;
  readonly sizeBytes: number | null;
}

/**
 * `lms ls --json`. Its `path` is relative to the models folder in current
 * builds; `modelsDir` makes it absolute. Rows without a key are dropped.
 */
export function parseLmsList(stdout: string, modelsDir: string | null): LmsListedModel[] {
  let body: unknown;
  try {
    body = JSON.parse(stdout.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(body)) return [];
  const out: LmsListedModel[] = [];
  for (const row of body) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const key = typeof r.modelKey === "string" ? r.modelKey : typeof r.path === "string" ? r.path : null;
    if (!key) continue;
    let path = typeof r.path === "string" && r.path ? r.path : null;
    if (path && !isAbsolute(path)) path = modelsDir ? join(modelsDir, path) : null;
    out.push({ modelKey: key, path, sizeBytes: typeof r.sizeBytes === "number" ? r.sizeBytes : null });
  }
  return out;
}

export async function lmsList(modelsDir: string | null, opts: LmsOptions = {}): Promise<LmsListedModel[]> {
  const res = await lms(["ls", "--json"], "list its models", opts, 30_000);
  return parseLmsList(res.stdout, modelsDir);
}
