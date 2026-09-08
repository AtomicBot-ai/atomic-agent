import { describe, expect, it } from "vitest";

import { resolveWindowsCliInvocation } from "./windows-cli-shim.js";

const WIN_ENV = {
  PATH: "C:\\npm;C:\\Windows\\System32",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
};

/**
 * `present` lists the files as they sit on disk. The predicate matches
 * case-insensitively because NTFS does, which is why a `claude.cmd` is
 * found under the `.CMD` suffix PATHEXT lists — the resolved path then
 * carries PATHEXT's casing, exactly as it would for cmd.exe itself.
 */
const RESOLVED_CLAUDE = "C:\\npm\\claude.CMD";

function onWindows(
  binary: string,
  args: readonly string[],
  present: readonly string[] = [],
  env: NodeJS.ProcessEnv = WIN_ENV,
) {
  const set = new Set(present.map((p) => p.toLowerCase()));
  return resolveWindowsCliInvocation({
    binary,
    args,
    platform: "win32",
    env,
    fileExists: (p) => set.has(p.toLowerCase()),
  });
}

describe("resolveWindowsCliInvocation on posix", () => {
  it("hands the pair back untouched", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(
        resolveWindowsCliInvocation({
          binary: "claude",
          args: ["--print", "--json-schema", '{"a":1}'],
          platform,
          env: {},
          fileExists: () => true,
        }),
      ).toEqual({
        command: "claude",
        args: ["--print", "--json-schema", '{"a":1}'],
        windowsVerbatimArguments: false,
      });
    }
  });
});

describe("resolveWindowsCliInvocation on win32", () => {
  it("routes a resolved .cmd shim through cmd.exe with verbatim argv", () => {
    const out = onWindows("claude", ["--print"], ["C:\\npm\\claude.cmd"]);
    expect(out.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(out.args).toEqual([
      "/d",
      "/s",
      "/c",
      `"${RESOLVED_CLAUDE} ^"--print^""`,
    ]);
    expect(out.windowsVerbatimArguments).toBe(true);
  });

  it("accepts an already-resolved absolute shim without touching PATH", () => {
    // What `resolveCliBinary` hands over, and what a configured
    // `binPath` looks like: no lookup should be needed.
    const out = onWindows("C:\\npm\\codex.cmd", ["exec"], []);
    expect(out.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(out.args[3]).toBe('"C:\\npm\\codex.cmd ^"exec^""');
  });

  it("takes .bat shims as well, in PATHEXT order", () => {
    const out = onWindows("codex", ["exec"], ["C:\\npm\\codex.bat"]);
    expect(out.windowsVerbatimArguments).toBe(true);
    expect(out.args[3]).toBe('"C:\\npm\\codex.BAT ^"exec^""');
  });

  it("leaves a real executable alone", () => {
    const out = onWindows("claude", ["--print"], ["C:\\npm\\claude.exe"]);
    expect(out).toEqual({
      command: "claude",
      args: ["--print"],
      windowsVerbatimArguments: false,
    });
  });

  it("leaves an unresolvable name alone so spawn still raises ENOENT", () => {
    const out = onWindows("claude", ["--print"], []);
    expect(out).toEqual({
      command: "claude",
      args: ["--print"],
      windowsVerbatimArguments: false,
    });
  });

  it("falls back to cmd.exe when ComSpec is unset", () => {
    const out = onWindows("claude", [], ["C:\\npm\\claude.cmd"], {
      PATH: "C:\\npm",
      PATHEXT: ".CMD",
    });
    expect(out.command).toBe("cmd.exe");
  });

  it("reads environment names case-insensitively, as Windows does", () => {
    const out = onWindows("claude", [], ["C:\\npm\\claude.cmd"], {
      Path: "C:\\npm",
      PathExt: ".CMD",
      COMSPEC: "D:\\cmd.exe",
    });
    expect(out.command).toBe("D:\\cmd.exe");
    expect(out.args[3]).toBe(`"${RESOLVED_CLAUDE}"`);
  });
});

describe("cmd argument escaping", () => {
  function escaped(arg: string): string {
    const out = onWindows("claude", [arg], ["C:\\npm\\claude.cmd"]);
    // Strip the wrapping quotes and the command, leaving one argument.
    return (out.args[3] ?? "").slice(1, -1).replace(`${RESOLVED_CLAUDE} `, "");
  }

  it("escapes a response schema delivered inline on argv", () => {
    // `claude` has schemaDelivery: "inline", so an argument of exactly
    // this shape is on the command line of every structured-output
    // request — braces, quotes, brackets and commas included.
    expect(escaped('{"type":"object","required":["reply"]}')).toBe(
      '^"{\\^"type\\^":\\^"object\\^"^,\\^"required\\^":^[\\^"reply\\^"^]}^"',
    );
  });

  it("escapes cmd metacharacters that would otherwise redirect or chain", () => {
    expect(escaped("a&b")).toBe('^"a^&b^"');
    expect(escaped("a|b")).toBe('^"a^|b^"');
    expect(escaped("a>b<c")).toBe('^"a^>b^<c^"');
    expect(escaped("100^2")).toBe('^"100^^2^"');
    expect(escaped("%PATH%")).toBe('^"^%PATH^%^"');
    expect(escaped("two words")).toBe('^"two^ words^"');
  });

  it("doubles backslashes before a quote and at the end of an argument", () => {
    expect(escaped('say \\"hi\\"')).toBe('^"say^ \\\\\\^"hi\\\\\\^"^"');
    expect(escaped("C:\\path\\")).toBe('^"C:\\path\\\\^"');
  });

  it("double-escapes for a node_modules/.bin shim, which re-enters cmd", () => {
    const target = "C:\\proj\\node_modules\\.bin\\claude.cmd";
    const out = onWindows(target, ["a&b"], []);
    expect(out.args[3]).toBe(`"${target} ^^^"a^^^&b^^^""`);
  });
});
