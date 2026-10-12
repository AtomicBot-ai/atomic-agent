import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCore } from "./core-client.js";
import { loadCoreSession } from "./core-sessions.js";
import { CORE_RETRY_HINT, CoreUnavailableError, toCoreUnavailable, withSwitchBackHint } from "./core-errors.js";
import { CORE_VERSION } from "./core-state.js";

const dirs: string[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "core-hint-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("ends a failed Core start with the retry hint only", async () => {
  const err = await ensureCore(fixture(), CORE_VERSION).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CoreUnavailableError);
  expect(err).toMatchObject({ stage: "start", reasonCode: "not_installed", retryable: true });
  expect((err as Error).message).toBe(`The Atomic Chat engine could not start: it is not installed yet. ${CORE_RETRY_HINT}`);
  expect((err as Error).message).not.toMatch(/llama/i);
});

it("ends a missing backend with the retry hint and no llama.cpp", async () => {
  const err = await loadCoreSession(fixture(), { role: "chat", modelId: "m", modelPath: "/m.gguf", port: 19092, args: [] }).catch((e: unknown) => e);
  expect(err).toMatchObject({ stage: "start", reasonCode: "not_installed" });
  expect((err as Error).message).toContain(CORE_RETRY_HINT);
  expect((err as Error).message).not.toMatch(/llama/i);
});

it("wraps once, keeps the first stage and leaves cancellation alone", () => {
  const first = toCoreUnavailable(new Error("Atomic Core did not become ready."), "start") as CoreUnavailableError;
  expect(first.reason).toBe("The Atomic Chat engine could not start: Atomic Core did not become ready.");
  expect(toCoreUnavailable(first, "backend")).toBe(first);
  expect(withSwitchBackHint(first)).toBe(first);
  const abort = new AbortController();
  abort.abort();
  const cancelled = new Error("cancelled");
  expect(toCoreUnavailable(cancelled, "download", abort.signal)).toBe(cancelled);
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  expect(withSwitchBackHint(aborted)).toBe(aborted);
  expect(withSwitchBackHint("plain")).toBe("plain");
});

it("classifies failures into fixed words with a retry decision", () => {
  const network = toCoreUnavailable(new TypeError("fetch failed"), "download") as CoreUnavailableError;
  expect(network.info).toMatchObject({ stage: "download", reasonCode: "network", retryable: true, reason: "The Atomic Chat engine could not be downloaded: fetch failed." });
  const server = toCoreUnavailable(Object.assign(new Error("bad gateway"), { status: 502 }), "backend") as CoreUnavailableError;
  expect(server.info).toMatchObject({ stage: "backend", reasonCode: "server", retryable: true });
  const disk = toCoreUnavailable(Object.assign(new Error("no space"), { code: "ENOSPC" }), "download") as CoreUnavailableError;
  expect(disk.info).toMatchObject({ stage: "download", reasonCode: "disk", retryable: false });
  expect(new CoreUnavailableError({ stage: "backend", reasonCode: "no_backend" }).retryable).toBe(false);
  expect(new CoreUnavailableError({ stage: "verify", reasonCode: "checksum" }).retryable).toBe(true);
});
