import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalyticsClient } from "../../analytics/analytics-client.js";
import { captureLocalEngineFailed } from "../../analytics/analytics-events.js";
import { coreAssetName, installCore } from "./core-install.js";
import { CoreUnavailableError } from "./core-errors.js";
import { coreSpawnReason } from "./core-spawn-reason.js";
import { CORE_VERSION } from "./core-state.js";

const downloads = vi.hoisted(() => ({ downloadFile: vi.fn(), discardPartialDownload: vi.fn() }));
vi.mock("../downloads/download-file.js", () => downloads);
const child = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("node:child_process")>(), execFile: child.execFile }));

const BINARY = "stand-in core binary";
const manifest = () => `${createHash("sha256").update(BINARY).digest("hex")}  ${coreAssetName(CORE_VERSION)}\n`;

/** The error shapes Node's execFile hands back for a failed `--version` run. */
const exitWith = (code: number) => Object.assign(new Error(`Command failed: /secret/path/core --version`), { code, killed: false, signal: null });
const errno = (code: string) => Object.assign(new Error(`spawn /secret/path/core ${code}`), { code, errno: -1, syscall: "spawn /secret/path/core" });
const timedOut = () => Object.assign(new Error("Command failed: /secret/path/core --version"), { code: null, killed: true, signal: "SIGTERM" });

const CASES: Array<[string, Error, string]> = [
  ["a DLL init failure (unsigned)", exitWith(3221225794), "spawn_dll_init"],
  ["a DLL init failure (signed)", exitWith(-1073741502), "spawn_dll_init"],
  ["access denied", errno("EACCES"), "spawn_access"],
  ["not permitted", errno("EPERM"), "spawn_access"],
  ["a file removed after download", errno("ENOENT"), "spawn_missing"],
  ["the 15 s timeout", timedOut(), "spawn_timeout"],
  ["another exit code", exitWith(1), "spawn_exit"],
];

describe("coreSpawnReason", () => {
  it.each(CASES)("maps %s", (_label, err, reason) => {
    expect(coreSpawnReason(err)).toBe(reason);
  });

  it("falls back to spawn for anything else", () => {
    expect(coreSpawnReason(errno("ENOEXEC"))).toBe("spawn");
    expect(coreSpawnReason(new Error("odd"))).toBe("spawn");
    expect(coreSpawnReason("odd")).toBe("spawn");
    expect(coreSpawnReason(null)).toBe("spawn");
  });

  it("every code passes the analytics fixed-word filter as itself", () => {
    const client = { capture: vi.fn() } as unknown as AnalyticsClient & { capture: ReturnType<typeof vi.fn> };
    for (const [, , reason] of CASES) captureLocalEngineFailed(client, { engine: "atomic-core", stage: "verify", reasonCode: reason });
    expect(client.capture.mock.calls.map(call => (call[1] as { reason_code: string }).reason_code)).toEqual(CASES.map(([, , reason]) => reason));
  });
});

describe("installCore version check failure", () => {
  let dir: string;
  beforeEach(() => {
    vi.resetAllMocks();
    dir = mkdtempSync(join(tmpdir(), "core-spawn-"));
    downloads.downloadFile.mockImplementation(async (_url: string, dest: string) => { writeFileSync(dest, BINARY); });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each(CASES)("records %s as its own retryable reason code", async (_label, failure, reason) => {
    child.execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => { cb(failure); });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(manifest()));
    const err = await installCore(dir, CORE_VERSION, {}, request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreUnavailableError);
    expect(err).toMatchObject({ stage: "verify", reasonCode: reason, retryable: true });
    expect(child.execFile.mock.calls[0]?.[1]).toEqual(["--version"]);
  });
});
