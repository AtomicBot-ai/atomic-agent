import { describe, expect, it } from "vitest";

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
  const dataDir = "/tmp/local-llm-data";

  it("joins backend and models dirs", () => {
    expect(resolveBackendDir(dataDir)).toBe("/tmp/local-llm-data/backend");
    expect(resolveModelsDir(dataDir)).toBe("/tmp/local-llm-data/models");
  });

  it("joins server binary path", () => {
    expect(resolveServerBinPath(dataDir, "llama-server")).toBe(
      "/tmp/local-llm-data/backend/llama-server",
    );
  });

  it("joins model paths", () => {
    expect(resolveModelDir(dataDir, "qwen-3.5-4b")).toBe(
      "/tmp/local-llm-data/models/qwen-3.5-4b",
    );
    expect(resolveModelFilePath(dataDir, "qwen-3.5-4b", "m.gguf")).toBe(
      "/tmp/local-llm-data/models/qwen-3.5-4b/m.gguf",
    );
  });

  it("joins version, pid, log paths", () => {
    expect(resolveVersionFilePath(dataDir)).toBe(
      "/tmp/local-llm-data/backend/backend-version.json",
    );
    expect(resolvePidFilePath(dataDir)).toBe("/tmp/local-llm-data/llama-server.pid");
    expect(resolveLogFilePath(dataDir)).toBe("/tmp/local-llm-data/llama-server.log");
  });
});
