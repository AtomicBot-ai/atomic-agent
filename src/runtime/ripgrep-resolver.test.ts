import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import {
  resolveRipgrepPath,
  resetRipgrepCache,
} from "./ripgrep-resolver.js";

describe("resolveRipgrepPath", () => {
  beforeEach(() => {
    resetRipgrepCache();
  });

  it("prefers ATOMIC_AGENT_RG_PATH override when it exists", () => {
    const override = "/custom/rg";
    const result = resolveRipgrepPath({
      env: { ATOMIC_AGENT_RG_PATH: override, PATH: "/usr/bin" },
      execPath: "/opt/app/atomic-agent-sidecar",
      cwd: "/repo",
      platform: "linux",
      fileExists: (p) => p === override,
    });
    expect(result).toBe(override);
  });

  it("falls back to bundled vendor/rg next to the SEA binary", () => {
    const execPath = "/opt/app/atomic-agent-sidecar";
    const bundled = join("/opt/app", "vendor", "rg");
    const result = resolveRipgrepPath({
      env: { PATH: "/usr/bin" },
      execPath,
      cwd: "/repo",
      platform: "linux",
      fileExists: (p) => p === bundled,
    });
    expect(result).toBe(bundled);
  });

  it("uses rg.exe on Windows for bundled lookup", () => {
    // The resolver uses path.dirname/join which run with the host's
    // separator semantics; feed it forward-slash paths so the unit test
    // is portable across hosts and still exercises the rg.exe suffix.
    const execPath = "/app/atomic-agent-sidecar.exe";
    const bundled = join("/app", "vendor", "rg.exe");
    const result = resolveRipgrepPath({
      env: { PATH: "/windows/system32" },
      execPath,
      cwd: "/repo",
      platform: "win32",
      fileExists: (p) => p === bundled,
    });
    expect(result).toBe(bundled);
  });

  it("falls back to @vscode/ripgrep in node_modules during dev", () => {
    const cwd = "/repo";
    const devBin = join(cwd, "node_modules", "@vscode", "ripgrep", "bin", "rg");
    const result = resolveRipgrepPath({
      env: { PATH: "/usr/bin" },
      execPath: "/usr/local/bin/node",
      cwd,
      platform: "linux",
      fileExists: (p) => p === devBin,
    });
    expect(result).toBe(devBin);
  });

  // The PATH-scan branch splits/joins with the host's `node:path` semantics
  // (`:` vs `;`, `/` vs `\`), so a POSIX-style PATH fixture only resolves on
  // a POSIX host. The Windows bundled-lookup path is covered above.
  it.skipIf(process.platform === "win32")("falls back to PATH lookup on posix", () => {
    const systemBin = "/opt/homebrew/bin/rg";
    const result = resolveRipgrepPath({
      env: { PATH: "/opt/homebrew/bin:/usr/bin" },
      execPath: "/usr/local/bin/node",
      cwd: "/repo",
      platform: "darwin",
      fileExists: (p) => p === systemBin,
    });
    expect(result).toBe(systemBin);
  });

  it("returns null when no candidate exists", () => {
    const result = resolveRipgrepPath({
      env: { PATH: "/nope" },
      execPath: "/usr/local/bin/node",
      cwd: "/repo",
      platform: "linux",
      fileExists: () => false,
    });
    expect(result).toBeNull();
  });

  it("handles empty PATH gracefully", () => {
    const result = resolveRipgrepPath({
      env: {},
      execPath: "/usr/local/bin/node",
      cwd: "/repo",
      platform: "linux",
      fileExists: () => false,
    });
    expect(result).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "ignores override when the file does not exist and continues the chain",
    () => {
      const systemBin = "/usr/bin/rg";
      const result = resolveRipgrepPath({
        env: { ATOMIC_AGENT_RG_PATH: "/does/not/exist", PATH: "/usr/bin" },
        execPath: "/usr/local/bin/node",
        cwd: "/repo",
        platform: "linux",
        fileExists: (p) => p === systemBin,
      });
      expect(result).toBe(systemBin);
    },
  );
});
