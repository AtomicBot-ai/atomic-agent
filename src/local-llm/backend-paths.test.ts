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
