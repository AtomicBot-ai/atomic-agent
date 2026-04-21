import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChromeExecutable } from "./find-chrome-executable.js";

describe("findChromeExecutable", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "atomic-chrome-exec-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("honours explicit executablePath when it exists on disk", () => {
    const exe = join(workDir, "my-chrome");
    writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(exe, 0o755);

    const result = findChromeExecutable({
      executablePath: exe,
      channel: "chrome",
    });
    expect(result).toEqual({ kind: "custom", path: exe });
  });

  it("throws when the explicit executablePath does not exist (fail loud, not silent)", () => {
    expect(() =>
      findChromeExecutable({
        executablePath: join(workDir, "does-not-exist"),
        channel: "chrome",
      }),
    ).toThrow(/browser executable not found/);
  });

  it("returns null on an unknown platform so callers can surface a clear error", () => {
    const result = findChromeExecutable({
      channel: "chrome",
      platform: "haiku" as NodeJS.Platform,
    });
    expect(result).toBeNull();
  });
});
