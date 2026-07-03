import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  path: "/tmp/atomic/config.json",
  file: {
    version: 1,
    localModels: { url: "http://a" },
    log: { level: "info" },
    agent: { maxSteps: 10 },
  } as Record<string, unknown>,
  parseThrows: false,
  written: null as unknown,
  resetCalls: 0,
};

class FakeConfigValidationError extends Error {}

vi.mock("../config/index.js", () => ({
  ConfigValidationError: FakeConfigValidationError,
  getConfig: () => ({ paths: { userConfigFile: state.path } }),
  ensureUserConfigFileSync: () => state.file,
  parseUserConfigFile: (merged: Record<string, unknown>) => {
    if (state.parseThrows) {
      throw new FakeConfigValidationError("bad value");
    }
    return merged;
  },
  writeUserConfigFileSync: (_path: string, next: unknown) => {
    state.written = next;
  },
  resetConfigCache: () => {
    state.resetCalls += 1;
  },
}));

const { getConfigFile, patchConfigFile } = await import("./config-service.js");
const { RuntimeApiError } = await import("./runtime-api-error.js");

beforeEach(() => {
  state.parseThrows = false;
  state.written = null;
  state.resetCalls = 0;
});

describe("config-service facade", () => {
  it("reads the config file with its path", () => {
    const result = getConfigFile();
    expect(result.path).toBe(state.path);
    expect(result.config).toEqual(state.file);
  });

  it("merges only localModels/log/agent and persists + resets cache", () => {
    const result = patchConfigFile({
      localModels: { url: "http://b" },
    } as never);
    expect(result.config.localModels).toEqual({ url: "http://b" });
    expect(state.written).not.toBeNull();
    expect(state.resetCalls).toBe(1);
  });

  it("maps a validation failure to invalid_request and does not write", () => {
    state.parseThrows = true;
    expect(() => patchConfigFile({ agent: {} } as never)).toThrowError(
      RuntimeApiError,
    );
    expect(state.written).toBeNull();
    expect(state.resetCalls).toBe(0);
  });
});
