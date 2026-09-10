import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hostFileStatus, readShimHead } from "./host-environment.js";

/**
 * The two host facts the Windows shim cannot guess, tested against real
 * files because that is where both bugs were: a `false` that meant
 * "could not tell", and a partial read reported as a whole one.
 *
 * The same `%*` detector the shim uses, so a head that "contains the
 * token" here means what it means there.
 */
const ARG_SUBSTITUTION = /%(?:\*|~[a-zA-Z$:]*[0-9]|[0-9])/;

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shim-probe-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function write(name: string, body: Buffer | string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

describe("readShimHead", () => {
  it("returns the head of an ordinary shim", () => {
    const path = write(
      "claude.cmd",
      '@ECHO off\r\nendLocal & "%_prog%" "%dp0%\\cli.js" %*\r\n',
    );
    const head = readShimHead(path);
    expect(head).not.toBeNull();
    expect(ARG_SUBSTITUTION.test(head ?? "")).toBe(true);
  });

  it("refuses to answer for a file bigger than the probe window", () => {
    // The dangerous shape: `%*` past the cap. A head truncated at 8 KiB
    // contains no substitution token, so returning it says "this shim
    // does not re-substitute" — and the caller picks the *single*
    // escaping, which is the one an argument can break out of. There is
    // no honest answer here short of reading more, so there is no
    // answer at all.
    const filler = `REM ${"x".repeat(9_000)}\r\n`;
    const path = write("big.cmd", `${filler}@node cli.js %*\r\n`);
    expect(readShimHead(path)).toBeNull();
    // …and the truncated read really would have said "no": this is the
    // case, not a rewording of the unreadable one.
    const truncated = filler.slice(0, 8 * 1024);
    expect(ARG_SUBSTITUTION.test(truncated)).toBe(false);
  });

  it("reads a shim that only just fits", () => {
    const body = `@node cli.js %*\r\nREM ${"x".repeat(8_000)}`;
    expect(body.length).toBeLessThan(8 * 1024);
    expect(readShimHead(write("snug.cmd", body))).toContain("%*");
  });

  it("sees through a UTF-16LE BOM, where the token reads as %\\0*\\0", () => {
    const path = write(
      "utf16.cmd",
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("@node cli.js %*\r\n", "utf16le"),
      ]),
    );
    expect(ARG_SUBSTITUTION.test(readShimHead(path) ?? "")).toBe(true);
  });

  it("is not fooled by a UTF-8 BOM either", () => {
    const path = write(
      "bom.cmd",
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("@node cli.js %*\r\n", "utf8"),
      ]),
    );
    expect(ARG_SUBSTITUTION.test(readShimHead(path) ?? "")).toBe(true);
  });

  it("declines UTF-16BE rather than guessing at it", () => {
    const le = Buffer.from("@node cli.js %*", "utf16le");
    le.swap16();
    const path = write(
      "be.cmd",
      Buffer.concat([Buffer.from([0xfe, 0xff]), le]),
    );
    expect(readShimHead(path)).toBeNull();
  });

  it("returns null for what it cannot open", () => {
    expect(readShimHead(join(dir, "nope.cmd"))).toBeNull();
    mkdirSync(join(dir, "adir.cmd"));
    expect(readShimHead(join(dir, "adir.cmd"))).toBeNull();
  });

  it("re-reads a shim npm has replaced", () => {
    const path = write("upgraded.cmd", "@node cli.js\r\n");
    expect(ARG_SUBSTITUTION.test(readShimHead(path) ?? "")).toBe(false);
    writeFileSync(path, "@node cli.js %* REM upgraded\r\n");
    expect(ARG_SUBSTITUTION.test(readShimHead(path) ?? "")).toBe(true);
  });
});

describe("hostFileStatus", () => {
  it("tells present from absent", () => {
    expect(hostFileStatus(write("claude.cmd", "@echo off"))).toBe("present");
    expect(hostFileStatus(join(dir, "gone.cmd"))).toBe("absent");
    // A file *under* a file: ENOTDIR, and just as absent.
    expect(hostFileStatus(join(dir, "claude.cmd", "deeper.cmd"))).toBe(
      "absent",
    );
  });

  it("reports a path it may not stat as unknown, not as missing", () => {
    // The bug `existsSync` cannot express: EACCES came back as `false`,
    // and a real install under a restricted directory was reported as
    // "was not found on PATH".
    if (process.getuid?.() === 0) return; // root is not denied anything
    const locked = join(dir, "locked");
    mkdirSync(locked);
    const path = join(locked, "claude.cmd");
    writeFileSync(path, "@echo off");
    chmodSync(locked, 0o000);
    try {
      expect(hostFileStatus(path)).toBe("unknown");
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
