import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CORE_VERSION, coreVersionDir } from "../core/core-state.js";
import { resolveManagedDevice } from "./gpu-devices.js";
import { CORE_BACKEND_MISSING, managedDeviceSource, managedDeviceTable, probeManagedDevices } from "./managed-devices.js";

/** Atomic Core with its backend installed: `backend.json` naming a llama-server under Core's data dir. */
function stageCoreBackend(dataDir: string, script: string[]): { bin: string; runs: string } {
  const binDir = join(coreVersionDir(dataDir, CORE_VERSION), "data", "llamacpp", "backends", "b9001", "macos-arm64", "build", "bin");
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, "llama-server");
  const runs = join(dataDir, "runs");
  writeFileSync(runs, "");
  writeFileSync(bin, ["#!/bin/sh", `echo "core $*" >> '${runs}'`, ...script].join("\n"), { mode: 0o755 });
  writeFileSync(
    join(coreVersionDir(dataDir, CORE_VERSION), "backend.json"),
    JSON.stringify({ coreVersion: CORE_VERSION, provider: "llamacpp", version: "b9001", backend: "macos-arm64", binary: bin, installedAt: "2026-10-12T00:00:00.000Z" }),
  );
  return { bin, runs };
}

describe("managedDeviceSource / managedDeviceTable", () => {
  it("under llama-server asks the agent's own build, run as is", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "managed-devices-own-"));
    try {
      const source = managedDeviceSource(dataDir, "llama-server");
      expect(source?.binPath).toBe(join(dataDir, "backend", process.platform === "win32" ? "llama-server.exe" : "llama-server"));
      expect(source?.spawn).toBeUndefined();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("under atomic-core with no backend installed has nothing to ask, and says so", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "managed-devices-none-"));
    try {
      expect(managedDeviceSource(dataDir, "atomic-core")).toBeNull();
      const table = managedDeviceTable(dataDir, "atomic-core");
      expect(await table()).toEqual([]);
      expect(table.failure()).toBe(CORE_BACKEND_MISSING);
      expect(await probeManagedDevices(dataDir, "atomic-core")).toEqual({ devices: [], error: CORE_BACKEND_MISSING });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "under atomic-core asks the llama-server Core recorded, once a launch, with Core's library path",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "managed-devices-core-"));
      try {
        const { bin, runs } = stageCoreBackend(dataDir, [
          'echo "Available devices:"',
          'echo "  CUDA0: NVIDIA GeForce RTX 4090 (24564 MiB, 23000 MiB free)"',
        ]);
        const source = managedDeviceSource(dataDir, "atomic-core");
        expect(source?.binPath).toBe(bin);
        const libVar = process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
        expect(source?.spawn?.env?.[libVar]?.split(":")[0]).toBe(join(bin, ".."));

        const table = managedDeviceTable(dataDir, "atomic-core");
        expect(await resolveManagedDevice("unused", "auto", { listDevices: table })).toBe("CUDA0");
        expect((await table())[0]).toMatchObject({ id: "CUDA0", freeMemMiB: 23_000 });
        expect(table.failure()).toBeNull();
        expect(readFileSync(runs, "utf-8").split("\n").filter(Boolean)).toEqual(["core --list-devices"]);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "a Core backend that cannot run is a failure with its reason, not a machine without a GPU",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "managed-devices-broken-"));
      try {
        stageCoreBackend(dataDir, ['echo "dyld: Library not loaded: @rpath/libggml.dylib" >&2', "exit 134"]);
        const probe = await probeManagedDevices(dataDir, "atomic-core");
        expect(probe.devices).toEqual([]);
        expect(probe.error).toBe("dyld: Library not loaded: @rpath/libggml.dylib");
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );
});
