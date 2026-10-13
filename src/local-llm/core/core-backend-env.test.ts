import { describe, expect, it } from "vitest";
import { coreBackendSpawn, coreCudaPaths, type CoreCudaProbe } from "./core-backend-env.js";

/** A host with exactly these directories (and these subdirectories listed under `listDir`). */
function probe(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, dirs: string[], listed: Record<string, string[]> = {}): CoreCudaProbe {
  return { platform, env, exists: (p) => dirs.includes(p), listDir: (d) => listed[d] ?? [] };
}

describe("coreBackendSpawn: Core's backend runs with its own directory on the library path, as Core runs it", () => {
  it("macOS: the binary's directory leads DYLD_LIBRARY_PATH", () => {
    const bin = "/d/core/versions/0.13.6/data/llamacpp/backends/b1/macos-arm64/build/bin/llama-server";
    const { env, cwd } = coreBackendSpawn(bin, {
      platform: "darwin",
      baseEnv: { PATH: "/usr/bin", DYLD_LIBRARY_PATH: "/opt/x" },
      probe: probe("darwin", {}, []),
    });
    expect(env.DYLD_LIBRARY_PATH).toBe("/d/core/versions/0.13.6/data/llamacpp/backends/b1/macos-arm64/build/bin:/opt/x");
    expect(env.PATH).toBe("/usr/bin");
    expect(cwd).toBeUndefined();
  });

  it("Linux: the binary's directory and the CUDA libraries Core would find lead LD_LIBRARY_PATH, CUDA bins lead PATH", () => {
    const bin = "/d/backends/b1/linux-cuda-12/build/bin/llama-server";
    const host = probe(
      "linux",
      { CUDA_HOME: "/opt/cuda-home" },
      ["/opt/cuda-home/lib64", "/opt/cuda-home/bin", "/usr/local/cuda/lib64", "/usr/local/cuda-12.4/lib64", "/usr/local/cuda-12.4/bin"],
      { "/usr/local": ["cuda-12.4", "share"] },
    );
    const { env } = coreBackendSpawn(bin, { platform: "linux", baseEnv: { PATH: "/usr/bin" }, probe: host });
    expect(env.LD_LIBRARY_PATH).toBe(
      "/d/backends/b1/linux-cuda-12/build/bin:/opt/cuda-home/lib64:/usr/local/cuda-12.4/lib64:/usr/local/cuda/lib64",
    );
    expect(env.PATH).toBe("/opt/cuda-home/bin:/usr/local/cuda-12.4/bin:/usr/bin");
  });

  it("Windows: the binary's directory and the CUDA toolkit bins lead PATH, whatever case it had, and it runs from its directory", () => {
    const bin = "C:\\Users\\u\\data\\core\\backends\\b1\\win-cuda-12\\build\\bin\\llama-server.exe";
    const exeDir = "C:\\Users\\u\\data\\core\\backends\\b1\\win-cuda-12\\build\\bin";
    const toolkit = "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA";
    const host = probe("win32", { ProgramFiles: "C:\\Program Files" }, [`${toolkit}\\v12.4\\bin`], { [toolkit]: ["v12.4"] });
    const { env, cwd } = coreBackendSpawn(bin, {
      platform: "win32",
      baseEnv: { Path: "C:\\Windows\\system32", ProgramFiles: "C:\\Program Files" },
      probe: host,
    });
    expect(env.PATH).toBe(`${exeDir};${toolkit}\\v12.4\\bin;C:\\Windows\\system32`);
    expect(env.Path).toBeUndefined();
    expect(cwd).toBe(exeDir);
  });

  it("drops the provider keys in the agent's environment, as for the Core daemon", () => {
    const { env } = coreBackendSpawn("/b/llama-server", {
      platform: "darwin",
      baseEnv: { OPENAI_API_KEY: "sk-1", HF_TOKEN: "hf", HOME: "/home/u" },
      probe: probe("darwin", {}, []),
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.HF_TOKEN).toBeUndefined();
    expect(env.HOME).toBe("/home/u");
  });
});

describe("coreCudaPaths", () => {
  it("finds nothing on a Mac", () => {
    expect(coreCudaPaths(probe("darwin", { CUDA_HOME: "/x" }, ["/x/lib64"]))).toEqual({ libDirs: [], binDirs: [] });
  });

  it("reads CUDA_PATH and every CUDA_PATH_V* on Windows", () => {
    const paths = coreCudaPaths(
      probe("win32", { CUDA_PATH: "C:\\cuda", CUDA_PATH_V12_4: "C:\\cuda124" }, ["C:\\cuda\\bin", "C:\\cuda124\\bin"]),
    );
    expect(paths.binDirs).toEqual(["C:\\cuda124\\bin", "C:\\cuda\\bin"].sort());
    expect(paths.libDirs).toEqual([]);
  });
});
