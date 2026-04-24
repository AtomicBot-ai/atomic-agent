import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLocalModelDef } from "./models-catalog.js";
import { downloadModel, isModelDownloaded } from "./model-installer.js";

describe("model-installer", () => {
  let dir: string;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "local_model-mi-"));
    prevFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  it("downloads model file when missing", async () => {
    const model = getLocalModelDef("qwen-3.5-4b");
    const payload = Buffer.alloc(1024, 7);
    globalThis.fetch = vi.fn(async () => {
      return new Response(payload, {
        status: 200,
        headers: { "content-length": String(payload.length) },
      });
    }) as typeof fetch;

    await downloadModel(dir, model);
    const path = join(dir, "models", model.id, model.filename);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).length).toBe(1024);
    expect(isModelDownloaded(dir, model)).toBe(true);
  });

  it("skips download when file already exists", async () => {
    const model = getLocalModelDef("qwen-3.5-4b");
    const payload = Buffer.alloc(64, 1);
    const fn = vi.fn(async () => {
      return new Response(payload, {
        status: 200,
        headers: { "content-length": String(payload.length) },
      });
    });
    globalThis.fetch = fn as unknown as typeof fetch;
    await downloadModel(dir, model);
    await downloadModel(dir, model);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
