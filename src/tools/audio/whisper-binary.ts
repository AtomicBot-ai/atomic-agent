import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { withToolchainEnv } from "../../sandbox/command-toolchain-env.js";

/**
 * Where the whisper.cpp command line and ffmpeg live (ATO-702).
 *
 * Lookup only; the download lives in `whisper-install.ts`. Order: the
 * binary an environment variable names, the copy the agent downloaded
 * into the models folder (Windows, Linux), then one the user installed
 * (`brew install whisper-cpp`, a distro package). The PATH search is the
 * PATH the process has plus
 * the toolchain folders a desktop-launched agent misses
 * (`withToolchainEnv`: `/opt/homebrew/bin` and friends), so a Homebrew
 * install works from the desktop app too.
 */

/** Points at a whisper.cpp CLI binary; wins over the PATH search. */
export const WHISPER_BIN_ENV = "ATOMIC_AGENT_WHISPER_BIN";
/** Points at an ffmpeg binary; wins over the PATH search. */
export const FFMPEG_BIN_ENV = "ATOMIC_AGENT_FFMPEG_BIN";

/**
 * Names the whisper.cpp CLI ships under, newest first. Homebrew's
 * `whisper-cpp` formula installs `whisper-cli`; older builds and some
 * distro packages still call it `whisper-cpp`. The bare `whisper` name is
 * NOT here: that is the Python openai-whisper CLI, whose arguments differ.
 */
export const WHISPER_BINARY_NAMES: readonly string[] = ["whisper-cli", "whisper-cpp"];

export interface BinaryLookupOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Test seam: true when `path` is an executable regular file. */
  isExecutable?: (path: string, platform: NodeJS.Platform) => boolean;
  /** Test seam: the PATH widening; default `withToolchainEnv`. */
  widenEnv?: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => NodeJS.ProcessEnv;
}

export type BinaryResolution =
  | { found: true; path: string; source: "env" | "managed" | "path" }
  | { found: false; reason: string };

function defaultIsExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * First `dir/name[ext]` on the PATH that is an executable file, trying
 * the names in order. On Windows the PATHEXT extensions are tried too.
 */
export function findExecutable(
  names: readonly string[],
  options: BinaryLookupOptions = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const env = (options.widenEnv ?? ((e, p) => withToolchainEnv(e, { platform: p })))(
    options.env ?? process.env,
    platform,
  );
  const pathValue = env.PATH ?? env.Path ?? "";
  const exts = platform === "win32"
    ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)]
    : [""];
  const sep = platform === "win32" ? ";" : delimiter;
  for (const name of names) {
    for (const dir of pathValue.split(sep)) {
      if (dir.length === 0) continue;
      for (const ext of exts) {
        const candidate = join(dir, name + ext);
        if (isExecutable(candidate, platform)) return candidate;
      }
    }
  }
  return null;
}

function resolveBinary(
  envVar: string,
  names: readonly string[],
  missing: string,
  options: BinaryLookupOptions,
  managed?: string,
): BinaryResolution {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const configured = env[envVar]?.trim();
  if (configured) {
    if (!isAbsolute(configured)) {
      return { found: false, reason: `${envVar} must be an absolute path (got "${configured}")` };
    }
    if (!isExecutable(configured, platform)) {
      return { found: false, reason: `${envVar} points at ${configured}, which is not an executable file` };
    }
    return { found: true, path: configured, source: "env" };
  }
  if (managed !== undefined && isExecutable(managed, platform)) return { found: true, path: managed, source: "managed" };
  const onPath = findExecutable(names, options);
  return onPath === null ? { found: false, reason: missing } : { found: true, path: onPath, source: "path" };
}

/** The install line the error text suggests, per platform. */
export function whisperInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "Install it with `brew install whisper-cpp`";
  if (platform === "win32") {
    return "Download whisper-bin-x64.zip from https://github.com/ggml-org/whisper.cpp/releases, unzip it and add the folder to PATH";
  }
  return "Install whisper.cpp from your package manager (or `brew install whisper-cpp`), or build it from https://github.com/ggml-org/whisper.cpp";
}

export function ffmpegInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "Install it with `brew install ffmpeg`";
  if (platform === "win32") return "Install it with `winget install ffmpeg`";
  return "Install it with your package manager, e.g. `sudo apt install ffmpeg`";
}

/**
 * The whisper.cpp CLI: `ATOMIC_AGENT_WHISPER_BIN`, else the downloaded
 * copy at `managed` (`managedWhisperBinary`), else the PATH.
 */
export function resolveWhisperBinary(options: BinaryLookupOptions = {}, managed?: string): BinaryResolution {
  const platform = options.platform ?? process.platform;
  return resolveBinary(
    WHISPER_BIN_ENV,
    WHISPER_BINARY_NAMES,
    `whisper.cpp (whisper-cli) is not installed. ${whisperInstallHint(platform)}, or set ${WHISPER_BIN_ENV} to its full path.`,
    options,
    managed,
  );
}

/** ffmpeg: `ATOMIC_AGENT_FFMPEG_BIN`, else the PATH. */
export function resolveFfmpegBinary(options: BinaryLookupOptions = {}): BinaryResolution {
  const platform = options.platform ?? process.platform;
  return resolveBinary(
    FFMPEG_BIN_ENV,
    ["ffmpeg"],
    `ffmpeg is not installed; it converts voice messages (OGG/Opus) and other audio into the 16 kHz WAV whisper.cpp reads. ${ffmpegInstallHint(platform)}, or set ${FFMPEG_BIN_ENV} to its full path.`,
    options,
  );
}
