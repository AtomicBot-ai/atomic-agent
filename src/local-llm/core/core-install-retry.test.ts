import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreAssetName, installCore, isCoreInstalled, withCoreRetries } from "./core-install.js";
import { CoreUnavailableError } from "./core-errors.js";
import { CORE_VERSION } from "./core-state.js";

const downloads = vi.hoisted(() => ({ downloadFile: vi.fn(), discardPartialDownload: vi.fn() }));
vi.mock("../downloads/download-file.js", () => downloads);

// A stand-in release binary: a script that prints the pinned version.
const BINARY = `#!/bin/sh\necho ${CORE_VERSION}\n`;
const manifest = () => `${createHash("sha256").update(BINARY).digest("hex")}  ${coreAssetName(CORE_VERSION)}\n`;
let dir: string;
beforeEach(() => {
  vi.resetAllMocks();
  dir = mkdtempSync(join(tmpdir(), "core-retry-"));
  downloads.downloadFile.mockImplementation(async (_url: string, dest: string) => { writeFileSync(dest, BINARY); });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("retries up to three times with backoff, and only what is worth retrying", async () => {
  const flaky = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 })).mockResolvedValue("ok");
  await expect(withCoreRetries(flaky, () => true, undefined, 1)).resolves.toBe("ok");
  expect(flaky).toHaveBeenCalledTimes(3);
  const failing = vi.fn().mockRejectedValue(new Error("down"));
  await expect(withCoreRetries(failing, () => true, undefined, 1)).rejects.toThrow("down");
  expect(failing).toHaveBeenCalledTimes(3);
  const fatal = vi.fn().mockRejectedValue(new Error("not found"));
  await expect(withCoreRetries(fatal, () => false, undefined, 1)).rejects.toThrow("not found");
  expect(fatal).toHaveBeenCalledTimes(1);
});

it("never retries a cancelled operation", async () => {
  const abort = new AbortController();
  const attempt = vi.fn(async () => { abort.abort(); throw new Error("cancelled"); });
  await expect(withCoreRetries(attempt, () => true, abort.signal, 1)).rejects.toThrow("cancelled");
  expect(attempt).toHaveBeenCalledTimes(1);
});

it.skipIf(process.platform === "win32")("retries the checksum manifest after a 5xx, then installs and verifies", async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
    .mockResolvedValue(new Response(manifest()));
  await installCore(dir, CORE_VERSION, {}, request);
  expect(request).toHaveBeenCalledTimes(2);
  expect(isCoreInstalled(dir, CORE_VERSION)).toBe(true);
  // The binary download resumes partials and is bounded to three server retries.
  expect(downloads.downloadFile.mock.calls[0]?.[2]).toMatchObject({ maxRetries: 3, retryDelayMs: 1_000 });
  expect(downloads.discardPartialDownload).toHaveBeenCalled();
});

it("does not retry a missing release and says what happened", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("missing", { status: 404 }));
  const err = await installCore(dir, CORE_VERSION, {}, request).catch((e: unknown) => e);
  expect(request).toHaveBeenCalledTimes(1);
  expect(err).toBeInstanceOf(CoreUnavailableError);
  expect(err).toMatchObject({ stage: "download" });
  expect(downloads.downloadFile).not.toHaveBeenCalled();
});

it("keeps a failed download's partial for the next attempt to resume", async () => {
  downloads.downloadFile.mockRejectedValue(Object.assign(new Error("Download failed: HTTP 503"), { status: 503 }));
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(manifest()));
  const err = await installCore(dir, CORE_VERSION, {}, request).catch((e: unknown) => e);
  expect(err).toMatchObject({ stage: "download", reasonCode: "server", retryable: true });
  expect(downloads.discardPartialDownload).not.toHaveBeenCalled();
  expect(isCoreInstalled(dir, CORE_VERSION)).toBe(false);
});

it("discards bytes that fail verification", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(`${"0".repeat(64)}  ${coreAssetName(CORE_VERSION)}\n`));
  const err = await installCore(dir, CORE_VERSION, {}, request).catch((e: unknown) => e);
  expect(err).toMatchObject({ stage: "verify", reasonCode: "checksum" });
  expect(downloads.discardPartialDownload).toHaveBeenCalled();
});

it("leaves a cancelled install untouched by the failure wrapper", async () => {
  const abort = new AbortController();
  abort.abort();
  const request = vi.fn<typeof fetch>().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
  const err = await installCore(dir, CORE_VERSION, { signal: abort.signal }, request).catch((e: unknown) => e);
  expect(err).not.toBeInstanceOf(CoreUnavailableError);
  expect(request).toHaveBeenCalledTimes(1);
});
