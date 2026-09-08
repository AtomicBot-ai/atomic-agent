import { describe, expect, it } from "vitest";

import { claudeCliAdapter } from "./claude-cli-adapter.js";
import {
  SubscriptionCliCommandLineError,
  SubscriptionCliNotInstalledError,
} from "./subscription-cli-errors.js";
import {
  MAX_CMD_COMMAND_LINE,
  resolveWindowsCliInvocation,
  SHIM_SUBSTITUTION_MARGIN,
} from "./windows-cli-shim.js";

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

/**
 * npm's cmd-shim, trimmed to the line that matters: it substitutes `%*`
 * back into a command line cmd parses a second time. Identical for a
 * global install and for `node_modules\.bin`, which is the whole point.
 */
const NPM_CMD_SHIM = [
  "@ECHO off",
  "SETLOCAL",
  "CALL :find_dp0",
  'IF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join("\r\n");

/** A batch file that never looks at its arguments. */
const ARGLESS_BAT = ["@ECHO off", "start notepad.exe", "EXIT /b"].join("\r\n");

function onWindows(
  binary: string,
  args: readonly string[],
  present: readonly string[] = [],
  env: NodeJS.ProcessEnv = WIN_ENV,
  readTarget: (path: string) => string | null = () => NPM_CMD_SHIM,
  undeterminable: readonly string[] = [],
) {
  const set = new Set(present.map((p) => p.toLowerCase()));
  const unknown = new Set(undeterminable.map((p) => p.toLowerCase()));
  return resolveWindowsCliInvocation({
    binary,
    args,
    platform: "win32",
    env,
    installHint: "Install Claude Code.",
    fileStatus: (p) =>
      set.has(p.toLowerCase())
        ? "present"
        : unknown.has(p.toLowerCase())
          ? "unknown"
          : "absent",
    readTarget,
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
          fileStatus: () => "present",
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
      `"${RESOLVED_CLAUDE} ^^^"--print^^^""`,
    ]);
    expect(out.windowsVerbatimArguments).toBe(true);
  });

  it("accepts an already-resolved absolute shim without touching PATH", () => {
    // What `resolveCliBinary` hands over, and what a configured
    // `binPath` looks like: no lookup should be needed — but it still
    // has to be on disk.
    const out = onWindows("C:\\npm\\codex.cmd", ["exec"], ["C:\\npm\\codex.cmd"]);
    expect(out.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(out.args[3]).toBe('"C:\\npm\\codex.cmd ^^^"exec^^^""');
  });

  it("takes .bat shims as well, in PATHEXT order", () => {
    const out = onWindows("codex", ["exec"], ["C:\\npm\\codex.bat"]);
    expect(out.windowsVerbatimArguments).toBe(true);
    expect(out.args[3]).toBe('"C:\\npm\\codex.BAT ^^^"exec^^^""');
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

  it("normalises the target and escapes the spaces and parens in it", () => {
    // The real target on a real machine:
    // C:\Users\<name>\AppData\Roaming\npm\claude.cmd — and a
    // Program Files (x86) install is just as ordinary.
    const binPath = "C:/Program Files (x86)/npm/./claude.cmd";
    const out = onWindows(binPath, [], [binPath]);
    expect(out.args[3]).toBe(
      '"C:\\Program^ Files^ ^(x86^)\\npm\\claude.cmd"',
    );
  });
});

describe("a target that is not on disk", () => {
  it("reports a configured binPath as not installed rather than wrapping it", () => {
    // Wrapped in `cmd /c` instead, this came back as cmd's own "The
    // system cannot find the path specified." inside a generic
    // invocation error.
    expect(() => onWindows("C:\\gone\\claude.cmd", ["--print"], [])).toThrow(
      SubscriptionCliNotInstalledError,
    );
    expect(() => onWindows("C:\\gone\\claude.cmd", ["--print"], [])).toThrow(
      /"C:\\gone\\claude\.cmd" was not found on PATH\. Install Claude Code\./,
    );
  });

  it("does not judge a relative path — it resolves against the child's cwd", () => {
    // Not ours to test for existence, so it is wrapped and left to cmd.
    const out = onWindows("tools\\claude.cmd", ["--print"], []);
    expect(out.args[3]).toBe('"tools\\claude.cmd ^^^"--print^^^""');
  });
});

describe("cmd argument escaping", () => {
  function escaped(
    arg: string,
    readTarget: (path: string) => string | null = () => NPM_CMD_SHIM,
  ): string {
    const out = onWindows(
      "claude",
      [arg],
      ["C:\\npm\\claude.cmd"],
      WIN_ENV,
      readTarget,
    );
    // Strip the wrapping quotes and the command, leaving one argument.
    return (out.args[3] ?? "").slice(1, -1).replace(`${RESOLVED_CLAUDE} `, "");
  }

  it("escapes a response schema delivered inline on argv", () => {
    // `claude` has schemaDelivery: "inline", so an argument of exactly
    // this shape is on the command line of every structured-output
    // request — braces, quotes, brackets and commas included.
    expect(escaped('{"type":"object","required":["reply"]}')).toBe(
      '^^^"{\\^^^"type\\^^^":\\^^^"object\\^^^"^^^,\\^^^"required\\^^^":^^^[\\^^^"reply\\^^^"^^^]}^^^"',
    );
  });

  it("escapes cmd metacharacters that would otherwise redirect or chain", () => {
    expect(escaped("a&b")).toBe('^^^"a^^^&b^^^"');
    expect(escaped("a|b")).toBe('^^^"a^^^|b^^^"');
    expect(escaped("a>b<c")).toBe('^^^"a^^^>b^^^<c^^^"');
    expect(escaped("100^2")).toBe('^^^"100^^^^2^^^"');
    expect(escaped("%PATH%")).toBe('^^^"^^^%PATH^^^%^^^"');
    expect(escaped("two words")).toBe('^^^"two^^^ words^^^"');
  });

  it("doubles backslashes before a quote and at the end of an argument", () => {
    expect(escaped('say \\"hi\\"')).toBe(
      '^^^"say^^^ \\\\\\^^^"hi\\\\\\^^^"^^^"',
    );
    expect(escaped("C:\\path\\")).toBe('^^^"C:\\path\\\\^^^"');
  });
});

/**
 * The gate on the second `^` pass. It used to be a path test — cmd-shim
 * under `node_modules\.bin` — which is not where `claude` lives for
 * almost anybody: npm installs it globally as `%APPDATA%\npm\claude.cmd`
 * from the *same* template, with the same `%*`. Single-escaped, an
 * argument carrying both a quote and a metacharacter breaks out of its
 * quotes at the shim's re-parse. So the gate now asks the file.
 */
describe("the double-escape gate", () => {
  const globalShim = "C:\\Users\\Some One\\AppData\\Roaming\\npm\\claude.cmd";

  it("double-escapes a global npm shim, which re-substitutes %* like any other", () => {
    const out = onWindows(globalShim, ["a&b"], [globalShim]);
    expect(out.args[3]).toBe(
      '"C:\\Users\\Some^ One\\AppData\\Roaming\\npm\\claude.cmd ^^^"a^^^&b^^^""',
    );
  });

  it("double-escapes a node_modules/.bin shim, which re-enters cmd the same way", () => {
    const target = "C:\\proj\\node_modules\\.bin\\claude.cmd";
    const out = onWindows(target, ["a&b"], [target]);
    expect(out.args[3]).toBe(`"${target} ^^^"a^^^&b^^^""`);
  });

  it("single-escapes a batch file that never reads its arguments", () => {
    const target = "C:\\tools\\claude.cmd";
    const out = onWindows(target, ["a&b"], [target], WIN_ENV, () => ARGLESS_BAT);
    expect(out.args[3]).toBe(`"${target} ^"a^&b^""`);
  });

  it("double-escapes when the shim cannot be read at all", () => {
    // Conservative on purpose: every shim these CLIs ship
    // re-substitutes, and a batch file that ignores its arguments cannot
    // be corrupted by an escape it never reads.
    const target = "C:\\tools\\claude.cmd";
    const out = onWindows(target, ["a&b"], [target], WIN_ENV, () => null);
    expect(out.args[3]).toBe(`"${target} ^^^"a^^^&b^^^""`);
  });

  it("counts %1 and %~dp1 as re-substitution too", () => {
    const target = "C:\\tools\\claude.cmd";
    for (const body of ["@node cli.js %1", "@node %~dpnx1"]) {
      const out = onWindows(target, ["a&b"], [target], WIN_ENV, () => body);
      expect(out.args[3]).toBe(`"${target} ^^^"a^^^&b^^^""`);
    }
  });
});

describe("command lines cmd.exe cannot carry", () => {
  const target = "C:\\npm\\claude.cmd";

  it("refuses a raw newline instead of letting cmd run the tail", () => {
    expect(() => onWindows(target, ["--model", "a\nwhoami"], [target])).toThrow(
      SubscriptionCliCommandLineError,
    );
    expect(() => onWindows(target, ["--model", "a\nwhoami"], [target])).toThrow(
      /raw newline/,
    );
    expect(() => onWindows(target, ["a\rb"], [target])).toThrow(
      /carriage return/,
    );
  });

  /** The whole command line, as Node hands it to CreateProcess. */
  function lineLength(
    xs: number,
    readTarget: (path: string) => string | null = () => NPM_CMD_SHIM,
  ): number {
    const out = onWindows(
      target,
      ["x".repeat(xs)],
      [target],
      WIN_ENV,
      readTarget,
    );
    return [out.command, ...out.args].join(" ").length;
  }

  it("stays under cmd's limit for an argument that only just fits", () => {
    const out = onWindows(target, ["x".repeat(7_000)], [target]);
    expect([out.command, ...out.args].join(" ").length).toBeLessThanOrEqual(
      MAX_CMD_COMMAND_LINE,
    );
  });

  /**
   * The boundary itself, not "somewhere around there": with 8000 and
   * 9000 on either side, `length <= MAX` and `length <= MAX + 1` are
   * indistinguishable.
   */
  it("pins the last command line cmd.exe accepts, character for character", () => {
    const argless = () => ARGLESS_BAT;
    expect(lineLength(8_129, argless)).toBe(MAX_CMD_COMMAND_LINE - 1);
    expect(lineLength(8_130, argless)).toBe(MAX_CMD_COMMAND_LINE);
    expect(() =>
      onWindows(target, ["x".repeat(8_131)], [target], WIN_ENV, argless),
    ).toThrow(/is 8192 characters and only 8191 are usable/);
  });

  /**
   * The outer line is not the only one with a limit. A shim that
   * substitutes `%*` builds a second command line —
   * `"%_prog%" "%dp0%\…\cli.js" <args>` — which cmd parses under the
   * same 8191, and whose ~170-character prefix outweighs what the
   * arguments lose when one `^` layer is stripped off them. Measured
   * against the real global `claude.cmd`, the outer line passed at 8116
   * while the inner one was already 8192: a ~76-character window in
   * which this check said yes and cmd then answered "The input line is
   * too long." So the substituting case is charged a margin.
   */
  it("holds a margin back for the line the shim itself builds", () => {
    const budget = MAX_CMD_COMMAND_LINE - SHIM_SUBSTITUTION_MARGIN;
    expect(lineLength(7_614)).toBe(budget);
    expect(() => onWindows(target, ["x".repeat(7_615)], [target])).toThrow(
      new RegExp(`only ${budget} are usable`),
    );
    // The reviewed hole: accepted before, rejected now.
    expect(() => onWindows(target, ["x".repeat(8_019)], [target])).toThrow(
      SubscriptionCliCommandLineError,
    );
    // A batch file that never re-substitutes builds no second line and
    // pays no margin: the very same argument goes through.
    expect(lineLength(8_019, () => ARGLESS_BAT)).toBeLessThanOrEqual(
      MAX_CMD_COMMAND_LINE,
    );
  });

  it("names the real limit rather than letting cmd answer with 'The input line is too long.'", () => {
    let thrown: unknown;
    try {
      onWindows(target, ["x".repeat(9_000)], [target]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SubscriptionCliCommandLineError);
    expect((thrown as SubscriptionCliCommandLineError).reason).toBe("too-long");
    expect((thrown as Error).message).toMatch(/8191/);
    expect((thrown as Error).message).toMatch(/response schema/);
  });

  /**
   * The adapter caps an inline schema at 32 KB, sized for
   * `CreateProcess`'s 32767 — through cmd the ceiling is 8191, and the
   * escaping inflates the line further. These two counts bracket it.
   */
  function schemaArgs(properties: number): string[] {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < properties; i += 1) {
      props[`field_${i}`] = { type: "string", description: `field ${i}` };
    }
    return claudeCliAdapter.streamArgs({
      model: "sonnet",
      systemPrompt: claudeCliAdapter.systemPrompt,
      responseSchema: { type: "object", properties: props },
      extraArgs: [],
    });
  }

  it("passes a modest inline schema straight through", () => {
    const out = onWindows(target, schemaArgs(20), [target]);
    expect(out.windowsVerbatimArguments).toBe(true);
  });

  it("rejects a schema the adapter is happy with but cmd is not", () => {
    // Well under the adapter's 32 KB argv budget, well over cmd's 8191.
    expect(() => onWindows(target, schemaArgs(100), [target])).toThrow(
      SubscriptionCliCommandLineError,
    );
  });
});

/**
 * The CRT escaping was two regex passes and is now one scan, because the
 * quote rule — `arg.replace(/(\\*)"/g, …)` — is quadratic on a run of
 * backslashes that never reaches a quote, and this runs synchronously on
 * the TUI's event loop in the spawn path. The rules themselves must not
 * have moved a character: cross-spawn's own 7.0.5 "fix" for the same
 * ReDoS changed the trailing-backslash semantics and under-doubles, so
 * "it matches cross-spawn" is not the check. This is.
 */
describe("the escaping rewrite is a rewrite, not a change", () => {
  const target = "C:\\npm\\claude.cmd";
  const META = /([()\][%!^"`<>&|;, *?])/g;

  /** The previous implementation, verbatim. */
  function referenceEscape(arg: string, doubleEscape: boolean): string {
    let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
    escaped = escaped.replace(/(\\*)$/, "$1$1");
    escaped = `"${escaped}"`;
    escaped = escaped.replace(META, "^$1");
    if (doubleEscape) escaped = escaped.replace(META, "^$1");
    return escaped;
  }

  function escapeThrough(arg: string, doubleEscape: boolean): string {
    const out = onWindows(target, [arg], [target], WIN_ENV, () =>
      doubleEscape ? NPM_CMD_SHIM : ARGLESS_BAT,
    );
    return (out.args[3] ?? "").slice(1, -1).replace(`${target} `, "");
  }

  /** Deterministic corpus; no seed drift between runs or machines. */
  function* corpus(): Generator<string> {
    const alphabet = [
      "\\", '"', "a", " ", "&", "^", "%", "|", "<", ">", "(", ")", "!", ",",
      "*", "?", "`", ";", "[", "]", "{", "}", ":", "$", "~", "/",
    ];
    let seed = 0x2f6e2b1;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    // Every string of length <= 2 over the alphabet, then random ones.
    for (const a of alphabet) {
      yield a;
      for (const b of alphabet) yield a + b;
    }
    for (let i = 0; i < 20_000; i += 1) {
      const length = 1 + Math.floor(next() * 12);
      let value = "";
      for (let j = 0; j < length; j += 1) {
        value += alphabet[Math.floor(next() * alphabet.length)];
      }
      yield value;
    }
    yield "";
    for (let run = 1; run <= 8; run += 1) {
      yield "\\".repeat(run);
      yield `a${"\\".repeat(run)}`;
      yield `${"\\".repeat(run)}"b`;
      yield `a${"\\".repeat(run)}"${"\\".repeat(run)}`;
    }
  }

  it("agrees with the regex form on every input in a 21k corpus", () => {
    let compared = 0;
    for (const arg of corpus()) {
      for (const doubleEscape of [false, true]) {
        const expected = referenceEscape(arg, doubleEscape);
        if (escapeThrough(arg, doubleEscape) !== expected) {
          // Reported through `expect` so the failure names the input.
          expect({ arg, doubleEscape, got: escapeThrough(arg, doubleEscape) })
            .toEqual({ arg, doubleEscape, got: expected });
        }
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(40_000);
  });

  it("does not spend a second escaping an argument it then rejects", () => {
    // 32k backslashes with no quote to end the run: 1.47 s of
    // synchronous work under the regex form, before the length check
    // that refuses the argument anyway.
    const started = performance.now();
    expect(() => onWindows(target, ["\\".repeat(32_000)], [target])).toThrow(
      SubscriptionCliCommandLineError,
    );
    expect(performance.now() - started).toBeLessThan(400);
  });
});

describe("targets that are there, missing, or unanswerable", () => {
  it("hands a drive-relative target to cmd instead of walking PATH", () => {
    // `C:claude.cmd` names the current directory *of drive C:*. It has
    // no separator, so the PATH x PATHEXT walk used to swallow it,
    // resolve nothing, and pass the raw `.cmd` to spawn — EINVAL, the
    // very failure this shim exists to prevent.
    const out = onWindows("C:claude.cmd", ["--print"], []);
    expect(out.windowsVerbatimArguments).toBe(true);
    expect(out.args[3]).toBe('"C:claude.cmd ^^^"--print^^^""');
  });

  it("does not call a binPath it was not allowed to stat 'not installed'", () => {
    // `existsSync` answers `false` for EACCES/EPERM and for a UNC share
    // that did not respond, so a working install under a restricted or
    // network path came back as "was not found on PATH". Only a genuine
    // ENOENT is absent; anything else goes to cmd, which can answer for
    // itself.
    const binPath = "\\\\fileserver\\tools\\claude.cmd";
    const out = onWindows(binPath, ["--print"], [], WIN_ENV, () => null, [
      binPath,
    ]);
    expect(out.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(out.args[3]).toBe(`"${binPath} ^^^"--print^^^""`);
  });

  it("does not call a PATH directory it may not stat 'not installed' either", () => {
    // The same asymmetry one level out. A PATH entry the user may
    // traverse but not stat makes every candidate under it `unknown`;
    // resolving nothing hands the bare name to `spawn`, which does no
    // PATHEXT search with `shell:false` — so a working `claude.cmd`
    // came back as "was not found on PATH". The batch candidate is
    // handed to cmd instead, which repeats the search itself.
    const out = onWindows("claude", ["--print"], [], WIN_ENV, () => null, [
      "C:\\npm\\claude.COM",
      "C:\\npm\\claude.EXE",
      "C:\\npm\\claude.BAT",
      "C:\\npm\\claude.CMD",
      "C:\\npm\\claude",
    ]);
    expect(out.command).toBe("C:\\Windows\\System32\\cmd.exe");
    // PATHEXT order, which is the order cmd itself would try them.
    expect(out.args[3]).toBe('"C:\\npm\\claude.BAT ^^^"--print^^^""');
  });

  it("prefers a definite hit further along PATH over an unanswerable one", () => {
    // "Cannot tell" is a fallback, not a match: it must not shadow a
    // candidate we can actually see, even one a PATH entry later.
    const out = onWindows(
      "claude",
      ["--print"],
      ["C:\\Windows\\System32\\claude.cmd"],
      WIN_ENV,
      () => NPM_CMD_SHIM,
      ["C:\\npm\\claude.COM"],
    );
    expect(out.args[3]).toBe(
      '"C:\\Windows\\System32\\claude.CMD ^^^"--print^^^""',
    );
  });

  it("still refuses one that is genuinely absent", () => {
    expect(() => onWindows("C:\\gone\\claude.cmd", [], [])).toThrow(
      SubscriptionCliNotInstalledError,
    );
  });

  it("says where the unescapable character is when it is in the path", () => {
    // "cannot be run through cmd.exe with this argument" sent the reader
    // hunting through argv for something that is in the target's path.
    const bad = "C:\\npm\\clau\u0000de.cmd";
    expect(() => onWindows(bad, ["--print"], [bad])).toThrow(
      /cannot be run through cmd\.exe at all: its resolved path contains a raw NUL/,
    );
  });
});
