import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractBackendArchive } from "./backend-staging.js";

/**
 * ATO-2454: the TurboQuant archives built with GGML_RPC=ON carry
 * `rpc-server` beside `llama-server` in `build/bin/`. The flatten step
 * must keep it next to the server binary, where `models rpc-worker`
 * looks (`resolveRpcServerBinary`), on both the POSIX and the Windows
 * layout.
 */
describe("extractBackendArchive keeps rpc-server beside llama-server (ATO-2454)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aa-staging-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function stage(files: Record<string, string>, binaryName: string): Promise<string> {
    const zip = new JSZip();
    for (const [name, body] of Object.entries(files)) zip.file(name, Buffer.from(body));
    const archive = join(dir, "engine.zip");
    writeFileSync(archive, await zip.generateAsync({ type: "nodebuffer" }));
    const staging = join(dir, "staging");
    await extractBackendArchive(archive, staging, binaryName);
    return staging;
  }

  it("flattens build/bin/rpc-server and its RPC backend library to the install root", async () => {
    const staging = await stage(
      {
        "build/bin/llama-server": "#!/bin/sh\necho server\n",
        "build/bin/rpc-server": "#!/bin/sh\necho rpc\n",
        "build/bin/libggml-rpc.so": "lib",
      },
      "llama-server",
    );
    expect(readFileSync(join(staging, "rpc-server"), "utf8")).toContain("echo rpc");
    expect(existsSync(join(staging, "libggml-rpc.so"))).toBe(true);
    expect(existsSync(join(staging, "build"))).toBe(false);
    if (process.platform !== "win32") expect(() => accessSync(join(staging, "rpc-server"), constants.X_OK)).not.toThrow();
  });

  it("keeps rpc-server.exe and ggml-rpc.dll in the Windows archive layout", async () => {
    const staging = await stage(
      {
        "build/bin/llama-server.exe": "MZ server",
        "build/bin/rpc-server.exe": "MZ rpc",
        "build/bin/ggml-rpc.dll": "MZ dll",
      },
      "llama-server.exe",
    );
    expect(readFileSync(join(staging, "rpc-server.exe"), "utf8")).toBe("MZ rpc");
    expect(existsSync(join(staging, "ggml-rpc.dll"))).toBe(true);
  });
});
