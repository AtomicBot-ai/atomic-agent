import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatDotenvReadWarning,
  loadDotenvFromStateDir,
} from "./load-dotenv.js";

/**
 * Read-failure behaviour of `loadDotenvFromStateDir` (#59): retries on
 * transient Windows-style lock errors, a loud structured error when the
 * file exists but stays unreadable, silence when it does not exist.
 * I/O is injected — EPERM cannot be produced portably on a real fs.
 */
describe("loadDotenvFromStateDir read retries", () => {
  let dir: string;
  let stderrCalls: string[];
  let originalWrite: typeof process.stderr.write;
  let originalFoo: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-dotenv-retry-"));
    stderrCalls = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      stderrCalls.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;
    originalFoo = process.env.ATOMIC_DOTENV_TEST_FOO;
    delete process.env.ATOMIC_DOTENV_TEST_FOO;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    rmSync(dir, { recursive: true, force: true });
    if (originalFoo === undefined) {
      delete process.env.ATOMIC_DOTENV_TEST_FOO;
    } else {
      process.env.ATOMIC_DOTENV_TEST_FOO = originalFoo;
    }
  });

  function errnoError(code: string, path: string): NodeJS.ErrnoException {
    const err = new Error(
      `${code}: operation not permitted, open '${path}'`,
    ) as NodeJS.ErrnoException;
    err.code = code;
    return err;
  }

  it("retries a transient EPERM and loads keys on a later attempt", () => {
    const path = join(dir, ".env");
    const sleeps: number[] = [];
    let calls = 0;
    const result = loadDotenvFromStateDir(dir, {
      readFile: () => {
        calls += 1;
        if (calls === 1) throw errnoError("EPERM", path);
        return "ATOMIC_DOTENV_TEST_FOO=alpha\n";
      },
      sleep: (ms) => sleeps.push(ms),
    });

    expect(result.exists).toBe(true);
    expect(result.error).toBeNull();
    expect(result.loaded).toEqual(["ATOMIC_DOTENV_TEST_FOO"]);
    expect(process.env.ATOMIC_DOTENV_TEST_FOO).toBe("alpha");
    expect(sleeps).toEqual([50]);
    // The transient failure recovered — no warning, and no value leak.
    expect(stderrCalls).toEqual([]);
  });

  it("persistent EPERM warns with path and guidance and does not throw", () => {
    const path = join(dir, ".env");
    const sleeps: number[] = [];
    const result = loadDotenvFromStateDir(dir, {
      readFile: () => {
        throw errnoError("EPERM", path);
      },
      sleep: (ms) => sleeps.push(ms),
    });

    expect(result.exists).toBe(false);
    expect(result.loaded).toEqual([]);
    expect(result.error).toEqual({
      code: "EPERM",
      message: `EPERM: operation not permitted, open '${path}'`,
      attempts: 3,
    });
    expect(sleeps).toEqual([50, 150]);
    const warning = stderrCalls.join("");
    expect(warning).toContain(path);
    expect(warning).toContain("EPERM");
    expect(warning).toContain("NOT loaded");
  });

  it("does not retry non-retryable codes", () => {
    const path = join(dir, ".env");
    const sleeps: number[] = [];
    const result = loadDotenvFromStateDir(dir, {
      readFile: () => {
        throw errnoError("EISDIR", path);
      },
      sleep: (ms) => sleeps.push(ms),
    });

    expect(sleeps).toEqual([]);
    expect(result.error).toMatchObject({ code: "EISDIR", attempts: 1 });
  });

  it("treats ENOENT on a retry attempt as a missing file, silently", () => {
    const path = join(dir, ".env");
    let calls = 0;
    const result = loadDotenvFromStateDir(dir, {
      readFile: () => {
        calls += 1;
        if (calls === 1) throw errnoError("EBUSY", path);
        throw errnoError("ENOENT", path);
      },
      sleep: () => {},
    });

    expect(result.exists).toBe(false);
    expect(result.error).toBeNull();
    expect(stderrCalls).toEqual([]);
  });
});

describe("formatDotenvReadWarning", () => {
  const failure = {
    code: "EPERM",
    message: "EPERM: operation not permitted, open 'C:\\Users\\u\\.atomic-agent\\.env'",
    attempts: 3,
  };

  it("names the path, the code, and Windows-specific fixes on win32", () => {
    const text = formatDotenvReadWarning(
      "C:\\Users\\u\\.atomic-agent\\.env",
      failure,
      "win32",
    );
    expect(text).toContain("C:\\Users\\u\\.atomic-agent\\.env");
    expect(text).toContain("EPERM after 3 attempts");
    expect(text).toContain("NOT loaded");
    expect(text).toContain("read-only");
    expect(text).toContain("antivirus");
    expect(text).toContain("icacls");
  });

  it("gives POSIX guidance elsewhere", () => {
    const text = formatDotenvReadWarning("/home/u/.atomic-agent/.env", failure, "linux");
    expect(text).toContain("chmod 600");
    expect(text).not.toContain("icacls");
  });
});
