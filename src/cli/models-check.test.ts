import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfig, resetConfigCache } from "../config/index.js";
import type { LocalConnectionCheck } from "../llm/recheck-local-connection.js";

import { runLocalModelsCheck } from "./models-check.js";

describe("models check (ATO-873)", () => {
  let stateDir: string;
  let stdoutChunks: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-models-check-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    stdoutChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  const verdict = (partial: Partial<LocalConnectionCheck>): LocalConnectionCheck => ({
    url: "http://127.0.0.1:8080",
    verdict: "not_model_server",
    ok: false,
    message: "http://127.0.0.1:8080 answers (http 404), but it isn't a model server.",
    portHint: "This address uses port 8080, llama.cpp's old default.",
    ...partial,
  });

  it("checks the configured address and prints the verdict, the words and the port hint", async () => {
    const recheck = vi.fn(async () => verdict({}));
    const code = await runLocalModelsCheck([], { recheck });
    expect(code).toBe(1);
    expect(recheck).toHaveBeenCalledWith(
      expect.objectContaining({ url: getConfig().localModels.url, managedPorts: expect.any(Array) }),
    );
    expect(stdoutChunks.join("")).toBe(
      [
        "url:            http://127.0.0.1:8080",
        "verdict:        not_model_server",
        "http://127.0.0.1:8080 answers (http 404), but it isn't a model server.",
        "This address uses port 8080, llama.cpp's old default.",
        "",
      ].join("\n"),
    );
  });

  it("exits 0 when a llama.cpp server answers", async () => {
    const recheck = vi.fn(async () =>
      verdict({ verdict: "ok", ok: true, message: "ready", portHint: null }),
    );
    expect(await runLocalModelsCheck([], { recheck })).toBe(0);
    expect(stdoutChunks.join("")).not.toContain("old default");
  });

  it("prints the result object with --json", async () => {
    const result = verdict({ verdict: "ollama", message: "answers like Ollama", portHint: null });
    const code = await runLocalModelsCheck(["--json"], { recheck: vi.fn(async () => result) });
    expect(code).toBe(1);
    expect(JSON.parse(stdoutChunks.join(""))).toEqual(result);
  });
});
