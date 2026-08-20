import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `atag` is the short alias for the CLI. It has to be created by every
 * install channel, and each channel owns its own file — so dropping it from
 * one while editing another is an easy mistake. These assertions are the
 * guard against a partially-installed alias.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(relative: string): string {
  return readFileSync(resolve(repoRoot, relative), "utf8");
}

describe("atag alias", () => {
  it("npm exposes it as a bin entry pointing at the CLI entrypoint", () => {
    const manifest = JSON.parse(read("package.json")) as {
      bin: Record<string, string>;
    };
    expect(manifest.bin.atag).toBe(manifest.bin["atomic-agent"]);
  });

  it("the POSIX installer links it next to the binary", () => {
    const script = read("scripts/install.sh");
    expect(script).toContain('link_alias atomic-agent "$INSTALL_DIR/atag"');
    // Relative link target, so moving the install dir does not break it.
    expect(script).toContain('ln -sfn "$1" "$2"');
  });

  it("the Windows installer writes an atag.cmd shim", () => {
    const script = read("scripts/install.ps1");
    expect(script).toContain('Join-Path $InstallDir "atag.cmd"');
    // %~dp0 keeps the shim pointed at the binary beside it.
    expect(script).toContain('"`"%~dp0atomic-agent.exe`" %*"');
  });

  it("is documented in the CLI help", () => {
    expect(read("src/cli/index.ts")).toContain("atag <command> [options]");
  });
});
