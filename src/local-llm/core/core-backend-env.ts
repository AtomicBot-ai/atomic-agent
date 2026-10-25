import { existsSync, readdirSync } from "node:fs";
import { coreDaemonEnv } from "./core-env.js";

/**
 * The environment Atomic Core gives the llama-server it installed, for the
 * one run the agent makes of that binary itself: `--list-devices`, read for
 * the device pick and the context fit before Core is asked to load.
 *
 * Core never runs its backend with the caller's bare environment. Its
 * runtime (atomic-chat-core `src/runtime/shared/env.ts`, `buildProcessEnv`)
 * puts the binary's own directory on the library path, adds the CUDA
 * runtime directories it finds, and on Windows also runs from that
 * directory. Without that, a build whose ggml backends or CUDA runtime sit
 * beside the binary cannot load them: `--list-devices` comes back with no
 * GPU, or the binary does not start at all, and a machine with a discrete
 * card was fitted as if it had none. This mirrors Core's rules so the
 * listing sees the devices the loaded model will.
 *
 * Secrets are dropped as for the Core daemon (`coreDaemonEnv`): a device
 * listing needs none of the provider keys in the agent's environment.
 */
export interface CoreBackendSpawn {
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface CoreCudaProbe {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  /** Directory names inside `dir`; `[]` when unreadable. */
  listDir: (dir: string) => string[];
}

const LINUX_COMMON_LIB_DIRS = [
  "/usr/local/cuda/lib64",
  "/usr/local/cuda/lib",
  "/usr/lib/cuda/lib64",
  "/usr/lib/cuda/lib",
  "/opt/cuda/lib64",
  "/opt/cuda/lib",
  "/usr/lib/x86_64-linux-gnu",
  "/usr/lib/x86_64-linux-gnu/nvidia",
];

function nodeCudaProbe(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): CoreCudaProbe {
  return {
    platform,
    env,
    exists: (path) => existsSync(path),
    listDir: (dir) => {
      try {
        return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        return [];
      }
    },
  };
}

/** Where a CUDA runtime may live on this host, as Core looks for it (`discoverCudaPaths`). */
export function coreCudaPaths(p: CoreCudaProbe): { libDirs: string[]; binDirs: string[] } {
  const libs = new Set<string>();
  const bins = new Set<string>();
  if (p.platform === "win32") {
    const cudaPath = p.env["CUDA_PATH"];
    if (cudaPath && p.exists(`${cudaPath}\\bin`)) bins.add(`${cudaPath}\\bin`);
    for (const [key, value] of Object.entries(p.env)) {
      if (key.startsWith("CUDA_PATH_V") && value && p.exists(`${value}\\bin`)) bins.add(`${value}\\bin`);
    }
    const toolkit = `${p.env["ProgramFiles"] ?? "C:\\Program Files"}\\NVIDIA GPU Computing Toolkit\\CUDA`;
    for (const name of p.listDir(toolkit)) {
      if (p.exists(`${toolkit}\\${name}\\bin`)) bins.add(`${toolkit}\\${name}\\bin`);
    }
  } else if (p.platform === "linux") {
    const home = p.env["CUDA_HOME"] ?? p.env["CUDA_PATH"];
    if (home) {
      for (const sub of ["lib64", "lib"]) if (p.exists(`${home}/${sub}`)) libs.add(`${home}/${sub}`);
      if (p.exists(`${home}/bin`)) bins.add(`${home}/bin`);
    }
    for (const dir of LINUX_COMMON_LIB_DIRS) if (p.exists(dir)) libs.add(dir);
    for (const name of p.listDir("/usr/local")) {
      if (!name.startsWith("cuda-")) continue;
      for (const sub of ["lib64", "lib", "bin"]) {
        const dir = `/usr/local/${name}/${sub}`;
        if (!p.exists(dir)) continue;
        if (sub === "bin") bins.add(dir);
        else libs.add(dir);
      }
    }
  }
  return { libDirs: [...libs].sort(), binDirs: [...bins].sort() };
}

const prepend = (items: string[], existing: string | undefined, sep: string): string => {
  const rest = (existing ?? "").replace(new RegExp(`\\${sep}+$`), "");
  return rest === "" ? items.join(sep) : `${items.join(sep)}${sep}${rest}`;
};

/** The binary's directory, whichever separator the path uses. */
function exeDirOf(binPath: string): string {
  const i = Math.max(binPath.lastIndexOf("/"), binPath.lastIndexOf("\\"));
  return i < 0 ? "." : binPath.slice(0, i);
}

export function coreBackendSpawn(
  binPath: string,
  opts: { platform?: NodeJS.Platform; baseEnv?: NodeJS.ProcessEnv; probe?: CoreCudaProbe } = {},
): CoreBackendSpawn {
  const platform = opts.platform ?? process.platform;
  const base = opts.baseEnv ?? process.env;
  const env = coreDaemonEnv(base);
  // Core reports to nobody from a device listing; the flag is for its daemon.
  delete env.ATOMIC_CORE_TELEMETRY;
  const exeDir = exeDirOf(binPath);
  const cuda = coreCudaPaths(opts.probe ?? nodeCudaProbe(platform, base));
  switch (platform) {
    case "linux":
      env.LD_LIBRARY_PATH = prepend([exeDir, ...cuda.libDirs], env.LD_LIBRARY_PATH, ":");
      if (cuda.binDirs.length > 0) env.PATH = prepend(cuda.binDirs, env.PATH, ":");
      return { env };
    case "win32": {
      // Windows names are case-insensitive; a copied env keeps whichever case it had.
      const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
      const existing = pathKey ? env[pathKey] : undefined;
      if (pathKey) delete env[pathKey];
      const dir = exeDir.startsWith("\\\\?\\") ? exeDir.slice(4) : exeDir;
      env.PATH = prepend([dir, ...cuda.binDirs], existing, ";");
      return { env, cwd: exeDir };
    }
    case "darwin":
      env.DYLD_LIBRARY_PATH = prepend([exeDir], env.DYLD_LIBRARY_PATH, ":");
      return { env };
    default:
      return { env };
  }
}
