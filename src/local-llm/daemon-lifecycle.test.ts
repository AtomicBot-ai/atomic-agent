import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { probeLlamaHealth, readRunningPid } from "./daemon-lifecycle.js";

describe("daemon-lifecycle", () => {
  let dir: string;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "local-llm-dm-"));
    prevFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = prevFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  it("probeLlamaHealth returns ok when body status is ok", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as typeof fetch;
    await expect(probeLlamaHealth(18991)).resolves.toBe("ok");
  });

  it("probeLlamaHealth returns loading for loading model", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ status: "loading model" }), {
        status: 200,
      });
    }) as typeof fetch;
    await expect(probeLlamaHealth(18991)).resolves.toBe("loading");
  });

  it("readRunningPid returns null for invalid pid file", () => {
    writeFileSync(join(dir, "llama-server.pid"), "not-a-number\n", "utf-8");
    expect(readRunningPid(dir)).toBeNull();
  });
});
