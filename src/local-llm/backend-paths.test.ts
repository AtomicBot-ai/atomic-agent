import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  resolveBackendDir,
  resolveLogFilePath,
  resolveModelDir,
  resolveModelFilePath,
  resolveModelsDir,
  resolvePidFilePath,
  resolveServerBinPath,
  resolveVersionFilePath,
} from "./backend-paths.js";
import { setModelsDirOverride } from "./models-dir-override.js";

describe("backend-paths", () => {
  // Use a platform-native base so the expected joins match `path.join`
  // output on both POSIX (`/`) and Windows (`\`).
  const dataDir = join("local-llm-data");

  it("joins backend and models dirs", () => {
    expect(resolveBackendDir(dataDir)).toBe(join(dataDir, "backend"));
    expect(resolveModelsDir(dataDir)).toBe(join(dataDir, "models"));
  });

  it("joins server binary path", () => {
    expect(resolveServerBinPath(dataDir, "llama-server")).toBe(
      join(dataDir, "backend", "llama-server"),
    );
  });

  it("uses the models folder override for every model path (ATO-2106)", () => {
    const external = join("external-disk", "models");
    setModelsDirOverride(external);
    try {
      expect(resolveModelsDir(dataDir)).toBe(external);
      expect(resolveModelFilePath(dataDir, "qwen-3.5-4b", "m.gguf")).toBe(
        join(external, "qwen-3.5-4b", "m.gguf"),
      );
      // Only the models move: the backend and the pid file stay put.
      expect(resolveBackendDir(dataDir)).toBe(join(dataDir, "backend"));
      expect(resolvePidFilePath(dataDir)).toBe(join(dataDir, "llama-server.pid"));
    } finally {
      setModelsDirOverride(null);
    }
    expect(resolveModelsDir(dataDir)).toBe(join(dataDir, "models"));
  });

  it("joins model paths", () => {
    expect(resolveModelDir(dataDir, "qwen-3.5-4b")).toBe(
      join(dataDir, "models", "qwen-3.5-4b"),
    );
    expect(resolveModelFilePath(dataDir, "qwen-3.5-4b", "m.gguf")).toBe(
      join(dataDir, "models", "qwen-3.5-4b", "m.gguf"),
    );
  });

  it("joins version, pid, log paths", () => {
    expect(resolveVersionFilePath(dataDir)).toBe(
      join(dataDir, "backend", "backend-version.json"),
    );
    expect(resolvePidFilePath(dataDir)).toBe(join(dataDir, "llama-server.pid"));
    expect(resolveLogFilePath(dataDir)).toBe(join(dataDir, "llama-server.log"));
  });
});
