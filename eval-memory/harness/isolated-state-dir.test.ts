import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  setupIsolatedStateDir,
  withIsolatedStateDir,
} from "./isolated-state-dir.js";

const LLAMA_URL = "http://127.0.0.1:18991";

describe("setupIsolatedStateDir", () => {
  it("creates an empty temp dir and materialises config.json", () => {
    const handle = setupIsolatedStateDir({
      profile: "hybrid",
      configOptions: { llamaUrl: LLAMA_URL },
    });
    try {
      expect(existsSync(handle.stateDir)).toBe(true);
      const cfgPath = join(handle.stateDir, "config.json");
      expect(existsSync(cfgPath)).toBe(true);
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
        memory: { embeddings: { enabled: boolean } };
        localModels: { url: string };
      };
      expect(cfg.localModels.url).toBe(LLAMA_URL);
      expect(cfg.memory.embeddings.enabled).toBe(true);
    } finally {
      handle.dispose();
    }
  });

  it("dispose() removes the temp dir and is idempotent", () => {
    const handle = setupIsolatedStateDir({
      profile: "none",
      configOptions: { llamaUrl: LLAMA_URL },
    });
    const path = handle.stateDir;
    handle.dispose();
    handle.dispose();
    expect(existsSync(path)).toBe(false);
  });

  it("respects cleanup: false (caller manages teardown)", () => {
    const handle = setupIsolatedStateDir({
      profile: "fts5_only",
      configOptions: { llamaUrl: LLAMA_URL },
      cleanup: false,
    });
    try {
      handle.dispose();
      expect(existsSync(handle.stateDir)).toBe(true);
    } finally {
      rmSync(handle.stateDir, { recursive: true, force: true });
    }
  });
});

describe("withIsolatedStateDir", () => {
  it("forwards the callback result and disposes after", async () => {
    let capturedPath = "";
    const result = await withIsolatedStateDir(
      {
        profile: "full_v2",
        configOptions: { llamaUrl: LLAMA_URL },
      },
      (handle) => {
        capturedPath = handle.stateDir;
        expect(existsSync(handle.stateDir)).toBe(true);
        return 42;
      },
    );
    expect(result).toBe(42);
    expect(existsSync(capturedPath)).toBe(false);
  });

  it("disposes even when the callback throws", async () => {
    let capturedPath = "";
    await expect(
      withIsolatedStateDir(
        {
          profile: "hybrid",
          configOptions: { llamaUrl: LLAMA_URL },
        },
        (handle) => {
          capturedPath = handle.stateDir;
          throw new Error("scenario failed");
        },
      ),
    ).rejects.toThrow("scenario failed");
    expect(existsSync(capturedPath)).toBe(false);
  });
});
