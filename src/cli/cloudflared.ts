/**
 * cloudflared as an optional external binary for `atag serve --tunnel`
 * (ATO-625). We never download or update it: it has to be on PATH, and
 * it runs with `--no-autoupdate`. This module finds it, builds its
 * arguments, reads the public address out of its log and stops it.
 */

import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

/** A quick tunnel (no account, random trycloudflare.com address) or a named one. */
export type TunnelRequest =
  | { mode: "quick" }
  | { mode: "named"; name: string; hostname: string };

export const CLOUDFLARED_INSTALL_HINT =
  "Install cloudflared and run serve again: macOS `brew install cloudflared`, " +
  "Windows `winget install --id Cloudflare.cloudflared`, Linux: the package from " +
  "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ . " +
  "atomic-agent never downloads it for you.";

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where `binary` resolves on PATH, or `null`. No shell, no download. */
export function findOnPath(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isExecutable: (path: string) => boolean = isExecutableFile,
): string | null {
  const pathValue = env.PATH ?? env.Path ?? "";
  const names =
    platform === "win32"
      ? [binary, ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean).map((ext) => binary + ext.toLowerCase())]
      : [binary];
  const path = platform === "win32" ? win32 : posix;
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The cloudflared command line. The origin is always the gateway
 * listener's loopback address, never the main API.
 */
export function cloudflaredArgs(request: TunnelRequest, originUrl: string): string[] {
  if (request.mode === "quick") {
    return ["tunnel", "--no-autoupdate", "--url", originUrl];
  }
  return ["tunnel", "--no-autoupdate", "run", "--url", originUrl, request.name];
}

/** `my.host.example` from `my.host.example`, `https://my.host.example/` and so on; `null` if not a hostname. */
export function normalizeTunnelHostname(value: string): string | null {
  const bare = value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(bare)) return null;
  return bare;
}

const QUICK_URL = /https:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.trycloudflare\.com\b/gi;

/**
 * The quick tunnel's public address in a chunk of cloudflared's log, or
 * `null`. `api.trycloudflare.com` is the service cloudflared asks for a
 * tunnel (it shows up in error lines), never the tunnel itself.
 */
export function parseQuickTunnelUrl(text: string): string | null {
  for (const match of text.matchAll(QUICK_URL)) {
    const label = match[1]?.toLowerCase();
    if (!label || label === "api") continue;
    return `https://${label}.trycloudflare.com`;
  }
  return null;
}

/** cloudflared logs this once a connection to Cloudflare's edge is up. */
const REGISTERED = /Registered tunnel connection/i;

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface StartCloudflaredOptions {
  binary: string;
  request: TunnelRequest;
  originUrl: string;
  spawn?: SpawnLike;
  /** How long to wait for the public address before giving up on it. */
  urlTimeoutMs?: number;
  /** How long `stop()` waits after SIGTERM before SIGKILL. */
  killGraceMs?: number;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface CloudflaredHandle {
  /** The public origin once it is known; `null` on timeout, spawn error or early exit. */
  readonly publicUrl: Promise<string | null>;
  /** The last few log lines, for an error message. */
  recentLog(): string[];
  /** Stop cloudflared and wait for it to exit (SIGKILL after the grace). */
  stop(): Promise<void>;
}

const DEFAULT_URL_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_GRACE_MS = 3_000;
const LOG_TAIL = 20;

export function startCloudflared(options: StartCloudflaredOptions): CloudflaredHandle {
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnLike);
  const child = spawn(options.binary, cloudflaredArgs(options.request, options.originUrl), {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const tail: string[] = [];
  let exited = false;
  let settle: (url: string | null) => void = () => {};
  const publicUrl = new Promise<string | null>((resolveUrl) => {
    let done = false;
    const timer = setTimeout(() => settle(null), options.urlTimeoutMs ?? DEFAULT_URL_TIMEOUT_MS);
    timer.unref?.();
    settle = (url) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveUrl(url);
    };
  });
  const exitPromise = new Promise<void>((resolveExit) => {
    child.once("exit", (code, signal) => {
      exited = true;
      settle(null);
      options.onExit?.(code, signal);
      resolveExit();
    });
    child.once("error", (err) => {
      tail.push(`spawn error: ${err.message}`);
      exited = true;
      settle(null);
      resolveExit();
    });
  });

  const onChunk = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > LOG_TAIL) tail.shift();
    }
    if (options.request.mode === "quick") {
      const url = parseQuickTunnelUrl(text);
      if (url) settle(url);
    } else if (REGISTERED.test(text)) {
      settle(`https://${options.request.hostname}`);
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  return {
    publicUrl,
    recentLog: () => [...tail],
    stop: async () => {
      if (exited) return;
      child.kill("SIGTERM");
      const grace = new Promise<"grace">((resolveGrace) => {
        const t = setTimeout(() => resolveGrace("grace"), options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
        t.unref?.();
      });
      if ((await Promise.race([exitPromise.then(() => "exit" as const), grace])) === "grace" && !exited) {
        child.kill("SIGKILL");
        await exitPromise;
      }
    },
  };
}
