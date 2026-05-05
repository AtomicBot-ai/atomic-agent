import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DotenvWriterError, setDotenvKey } from "./dotenv-writer.js";

import { loadDotenvFromStateDir } from "./load-dotenv.js";

describe("setDotenvKey", () => {
  let stateDir: string;
  let envPath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "dotenv-writer-"));
    envPath = join(stateDir, ".env");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.SOME_OTHER_KEY;
  });

  it("creates a fresh .env when none exists", () => {
    const result = setDotenvKey(stateDir, "TELEGRAM_BOT_TOKEN", "abc:xyz");

    expect(result.path).toBe(envPath);
    expect(result.preexisting).toBe(false);
    expect(result.changed).toBe(true);
    expect(readFileSync(envPath, "utf8")).toBe("TELEGRAM_BOT_TOKEN=abc:xyz\n");
  });

  it("writes the file with mode 0600", () => {
    setDotenvKey(stateDir, "TELEGRAM_BOT_TOKEN", "secret");
    const mode = statSync(envPath).mode & 0o777;
    if (process.platform === "win32") {
      // Windows ignores POSIX permission bits; the value is platform-defined.
      expect(typeof mode).toBe("number");
    } else {
      expect(mode).toBe(0o600);
    }
  });

  it("updates an existing key in place without disturbing surrounding lines", () => {
    writeFileSync(
      envPath,
      [
        "# A comment",
        "FIRST_KEY=foo",
        "",
        "TELEGRAM_BOT_TOKEN=old-value",
        "LAST_KEY=bar",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = setDotenvKey(stateDir, "TELEGRAM_BOT_TOKEN", "new-value");

    expect(result.preexisting).toBe(true);
    expect(result.changed).toBe(true);
    expect(readFileSync(envPath, "utf8")).toBe(
      [
        "# A comment",
        "FIRST_KEY=foo",
        "",
        "TELEGRAM_BOT_TOKEN=new-value",
        "LAST_KEY=bar",
        "",
      ].join("\n"),
    );
  });

  it("appends a new key when the file exists but lacks it", () => {
    writeFileSync(envPath, "FIRST_KEY=foo\n", "utf8");

    const result = setDotenvKey(stateDir, "TELEGRAM_BOT_TOKEN", "abc");

    expect(result.changed).toBe(true);
    expect(readFileSync(envPath, "utf8")).toBe(
      "FIRST_KEY=foo\nTELEGRAM_BOT_TOKEN=abc\n",
    );
  });

  it("returns changed=false when the key already has the requested value", () => {
    writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=same\n", "utf8");

    const result = setDotenvKey(stateDir, "TELEGRAM_BOT_TOKEN", "same");

    expect(result.changed).toBe(false);
    expect(readFileSync(envPath, "utf8")).toBe("TELEGRAM_BOT_TOKEN=same\n");
  });

  it("removes a key when value is null and leaves other keys intact", () => {
    writeFileSync(
      envPath,
      ["FIRST_KEY=foo", "TELEGRAM_BOT_TOKEN=bye", "LAST_KEY=bar", ""].join(
        "\n",
      ),
      "utf8",
    );

    const result = setDotenvKey(stateDir, "TELEGRAM_BOT_TOKEN", null);

    expect(result.changed).toBe(true);
    expect(readFileSync(envPath, "utf8")).toBe(
      ["FIRST_KEY=foo", "LAST_KEY=bar", ""].join("\n"),
    );
  });

  it("is a no-op when removing a missing key from a non-existent file", () => {
    const result = setDotenvKey(stateDir, "TELEGRAM_BOT_TOKEN", null);

    expect(result.changed).toBe(false);
    expect(result.preexisting).toBe(false);
    expect(existsSync(envPath)).toBe(false);
  });

  it("is a no-op when removing a missing key from an existing file", () => {
    writeFileSync(envPath, "FIRST_KEY=foo\n", "utf8");
    const result = setDotenvKey(stateDir, "TELEGRAM_BOT_TOKEN", null);
    expect(result.changed).toBe(false);
    expect(result.preexisting).toBe(true);
    expect(readFileSync(envPath, "utf8")).toBe("FIRST_KEY=foo\n");
  });

  it("unlinks the file when removing the last remaining key", () => {
    writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=bye\n", "utf8");

    const result = setDotenvKey(stateDir, "TELEGRAM_BOT_TOKEN", null);

    expect(result.changed).toBe(true);
    expect(existsSync(envPath)).toBe(false);
  });

  it("rejects invalid keys", () => {
    expect(() => setDotenvKey(stateDir, "lower_case", "x")).toThrow(
      DotenvWriterError,
    );
    expect(() => setDotenvKey(stateDir, "WITH-DASH", "x")).toThrow(
      DotenvWriterError,
    );
    expect(() => setDotenvKey(stateDir, "", "x")).toThrow(DotenvWriterError);
  });

  it("quotes values that contain whitespace or hash so the reader round-trips", () => {
    setDotenvKey(stateDir, "SOME_OTHER_KEY", "value with spaces #1");
    const result = loadDotenvFromStateDir(stateDir);
    expect(result.loaded).toContain("SOME_OTHER_KEY");
    expect(process.env.SOME_OTHER_KEY).toBe("value with spaces #1");
  });

  it("uses single-quotes when the value contains double-quotes", () => {
    setDotenvKey(stateDir, "SOME_OTHER_KEY", 'has "quotes" inside');
    const raw = readFileSync(envPath, "utf8");
    expect(raw).toBe(`SOME_OTHER_KEY='has "quotes" inside'\n`);
    const result = loadDotenvFromStateDir(stateDir);
    expect(result.loaded).toContain("SOME_OTHER_KEY");
    expect(process.env.SOME_OTHER_KEY).toBe('has "quotes" inside');
  });

  it("does not log or expose the value through the result object", () => {
    const result = setDotenvKey(stateDir, "TELEGRAM_BOT_TOKEN", "secret-value");
    // Result keys should be exactly { path, preexisting, changed }.
    expect(Object.keys(result).sort()).toEqual([
      "changed",
      "path",
      "preexisting",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });
});
