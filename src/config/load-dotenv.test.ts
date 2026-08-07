import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadDotenvFromStateDir } from "./load-dotenv.js";

const MANAGED_KEYS = [
  "ATOMIC_DOTENV_TEST_FOO",
  "ATOMIC_DOTENV_TEST_BAR",
  "ATOMIC_DOTENV_TEST_BAZ",
  "ATOMIC_DOTENV_TEST_QUOTED",
  "ATOMIC_DOTENV_TEST_SINGLE",
  "ATOMIC_DOTENV_TEST_KEEP",
];

describe("loadDotenvFromStateDir", () => {
  let dir: string;
  let stderrCalls: string[];
  let originalWrite: typeof process.stderr.write;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-dotenv-"));
    stderrCalls = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      stderrCalls.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;
    originalEnv = {};
    for (const key of MANAGED_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    rmSync(dir, { recursive: true, force: true });
    for (const key of MANAGED_KEYS) {
      const prev = originalEnv[key];
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  });

  it("missing file returns exists:false and mutates nothing", () => {
    const result = loadDotenvFromStateDir(dir);
    expect(result).toEqual({
      path: join(dir, ".env"),
      exists: false,
      loaded: [],
      skipped: [],
      error: null,
    });
    expect(process.env.ATOMIC_DOTENV_TEST_FOO).toBeUndefined();
    expect(stderrCalls).toEqual([]);
  });

  it("loads valid KEY=VALUE entries into process.env", () => {
    writeFileSync(
      join(dir, ".env"),
      "ATOMIC_DOTENV_TEST_FOO=alpha\nATOMIC_DOTENV_TEST_BAR=beta\n",
      "utf8",
    );

    const result = loadDotenvFromStateDir(dir);

    expect(result.exists).toBe(true);
    expect(result.loaded.sort()).toEqual([
      "ATOMIC_DOTENV_TEST_BAR",
      "ATOMIC_DOTENV_TEST_FOO",
    ]);
    expect(result.skipped).toEqual([]);
    expect(process.env.ATOMIC_DOTENV_TEST_FOO).toBe("alpha");
    expect(process.env.ATOMIC_DOTENV_TEST_BAR).toBe("beta");
  });

  it("never overwrites a variable already set in process.env", () => {
    process.env.ATOMIC_DOTENV_TEST_KEEP = "shell-wins";
    writeFileSync(
      join(dir, ".env"),
      "ATOMIC_DOTENV_TEST_KEEP=file-loses\nATOMIC_DOTENV_TEST_FOO=fresh\n",
      "utf8",
    );

    const result = loadDotenvFromStateDir(dir);

    expect(result.loaded).toEqual(["ATOMIC_DOTENV_TEST_FOO"]);
    expect(result.skipped).toEqual(["ATOMIC_DOTENV_TEST_KEEP"]);
    expect(process.env.ATOMIC_DOTENV_TEST_KEEP).toBe("shell-wins");
    expect(process.env.ATOMIC_DOTENV_TEST_FOO).toBe("fresh");
  });

  it("strips matching surrounding double or single quotes", () => {
    writeFileSync(
      join(dir, ".env"),
      [
        'ATOMIC_DOTENV_TEST_QUOTED="hello world"',
        "ATOMIC_DOTENV_TEST_SINGLE='value with spaces'",
        "",
      ].join("\n"),
      "utf8",
    );

    loadDotenvFromStateDir(dir);

    expect(process.env.ATOMIC_DOTENV_TEST_QUOTED).toBe("hello world");
    expect(process.env.ATOMIC_DOTENV_TEST_SINGLE).toBe("value with spaces");
  });

  it("ignores blank lines and # comments without warning", () => {
    writeFileSync(
      join(dir, ".env"),
      [
        "# top-of-file comment",
        "",
        "ATOMIC_DOTENV_TEST_FOO=ok",
        "   ",
        "# another comment",
        "ATOMIC_DOTENV_TEST_BAR=also-ok",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = loadDotenvFromStateDir(dir);

    expect(result.loaded.sort()).toEqual([
      "ATOMIC_DOTENV_TEST_BAR",
      "ATOMIC_DOTENV_TEST_FOO",
    ]);
    expect(stderrCalls).toEqual([]);
  });

  it("warns and skips malformed lines without aborting the file", () => {
    writeFileSync(
      join(dir, ".env"),
      [
        "this line has no equals sign",
        "ATOMIC_DOTENV_TEST_FOO=valid",
        "ATOMIC_DOTENV_TEST_BAR=also-valid",
      ].join("\n"),
      "utf8",
    );

    const result = loadDotenvFromStateDir(dir);

    expect(result.loaded.sort()).toEqual([
      "ATOMIC_DOTENV_TEST_BAR",
      "ATOMIC_DOTENV_TEST_FOO",
    ]);
    expect(stderrCalls.join("")).toMatch(/missing '=' on line 1/);
  });

  it("reports a torn line by position only, never echoing its content", () => {
    // A non-atomic external writer can leave a partial line that is a
    // fragment of a secret value. The diagnostic must locate it without
    // repeating it.
    const fragment = "sk-torn-secret-fragment-abc123";
    writeFileSync(
      join(dir, ".env"),
      [fragment, "ATOMIC_DOTENV_TEST_FOO=fine"].join("\n"),
      "utf8",
    );

    const result = loadDotenvFromStateDir(dir);

    expect(result.loaded).toEqual(["ATOMIC_DOTENV_TEST_FOO"]);
    const stderr = stderrCalls.join("");
    expect(stderr).toContain("missing '=' on line 1");
    expect(stderr).not.toContain(fragment);
  });

  it("rejects keys that do not match the canonical pattern", () => {
    writeFileSync(
      join(dir, ".env"),
      [
        "lowercase=nope",
        "with-dash=nope",
        "ATOMIC_DOTENV_TEST_FOO=fine",
      ].join("\n"),
      "utf8",
    );

    const result = loadDotenvFromStateDir(dir);

    expect(result.loaded).toEqual(["ATOMIC_DOTENV_TEST_FOO"]);
    expect(stderrCalls.join("")).toMatch(/invalid key 'lowercase'/);
    expect(stderrCalls.join("")).toMatch(/invalid key 'with-dash'/);
  });

  it("returns names only, never values", () => {
    writeFileSync(
      join(dir, ".env"),
      "ATOMIC_DOTENV_TEST_FOO=super-secret-token-do-not-leak\n",
      "utf8",
    );

    const result = loadDotenvFromStateDir(dir);

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("super-secret-token-do-not-leak");
    expect(result.loaded).toEqual(["ATOMIC_DOTENV_TEST_FOO"]);
  });
});
