import { chmod, mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CheckerRun,
  type CheckerRunner,
  checkJavaScriptFile,
  checkPythonFile,
  checkShellFile,
  nodeCheck,
  nodeForSyntaxCheck,
  runChecker,
} from "./check-script-syntax.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atag-verify-script-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
}

describe("runChecker", () => {
  it("reports a missing binary instead of throwing", async () => {
    const run = await runChecker("atag-no-such-binary-xyz", ["--version"]);
    expect(run.missing).toBe(true);
    expect(run.exitCode).toBeNull();
  });
});

describe("checkJavaScriptFile", () => {
  it("passes a plain script in-process", async () => {
    const path = await file("a.js", "const a = {b: 1};\nconsole.log(a);\n");
    const out = await checkJavaScriptFile(path, "const a = {b: 1};\nconsole.log(a);\n");
    expect(out).toMatchObject({ ok: true, checker: "node-vm" });
  });

  it("fails an unclosed object literal with the line", async () => {
    const src = "const a = {\n  b: 1,\n";
    const path = await file("a.js", src);
    const out = await checkJavaScriptFile(path, src);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/^SyntaxError: /);
  });

  it("falls back to one `node --check` for an ES module the vm parser cannot judge", async () => {
    const good = "import { x } from './x.js';\nexport const y = x + 1;\n";
    const goodPath = await file("good.mjs", good);
    expect(await checkJavaScriptFile(goodPath, good)).toMatchObject({
      ok: true,
      checker: "node --check",
    });
    const bad = "import { x } from './x.js';\nexport const y = ;\n";
    const badPath = await file("bad.mjs", bad);
    const out = await checkJavaScriptFile(badPath, bad);
    expect(out).toMatchObject({ ok: false, checker: "node --check" });
    expect(out.error).toMatch(/SyntaxError: .* \(line 2\)/);
    // Two node spawns; slow under a full parallel suite.
  }, 60_000);

  it("checks JSON in-process and reports the parse error", async () => {
    const src = '{"a": 1,}';
    const path = await file("package.json", src);
    const out = await checkJavaScriptFile(path, src);
    expect(out.ok).toBe(false);
    expect(out.checker).toBe("node-vm");
  });
});

describe("nodeCheck in a release build", () => {
  it("uses node from PATH when this process is the release binary", () => {
    expect(nodeForSyntaxCheck(true, "/opt/atomic-agent/atomic-agent")).toBe("node");
    expect(nodeForSyntaxCheck(false, "/usr/local/bin/node")).toBe("/usr/local/bin/node");
  });

  it("reports unchecked, not failed, when no Node.js is found", async () => {
    const path = await file("a.mjs", "export const a = 1;\n");
    const out = await nodeCheck(path, path, "atag-no-such-node-xyz");
    expect(out.ok).toBeNull();
    expect(out.error).toMatch(/no Node\.js found on PATH/);
  });

  it.skipIf(process.platform === "win32")(
    "reports unchecked when the binary does not know --check",
    async () => {
      // The release binary answered `--check` with this and exit 1, and
      // every file was counted as a syntax failure.
      const fake = await file(
        "fake-agent",
        "#!/bin/sh\necho 'unknown command: --check' >&2\nexit 1\n",
      );
      await chmod(fake, 0o755);
      const path = await file("a.mjs", "export const a = 1;\n");
      const out = await nodeCheck(path, path, fake);
      expect(out.ok).toBeNull();
      expect(out.checker).toBe("node --check");
      expect(out.error).toContain("node --check did not run");
      expect(out.error).toContain("unknown command: --check");
    },
  );
});

describe("checkPythonFile", () => {
  it("compiles without leaving bytecode next to the file", async () => {
    const path = await file("ok.py", "def f(x):\n    return x + 1\n");
    const out = await checkPythonFile(path);
    if (out.checker === "none") {
      expect(out.ok).toBeNull();
      expect(out.error).toBe("no working Python 3 found");
      return;
    }
    expect(out.ok).toBe(true);
    expect(await readdir(dir)).toEqual(["ok.py"]);
  });

  it("reports a syntax error with the traceback tail", async () => {
    const path = await file("bad.py", "def f(x)\n    return x\n");
    const out = await checkPythonFile(path);
    if (out.checker === "none") return;
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/SyntaxError/);
    expect(await readdir(dir)).toEqual(["bad.py"]);
  });
});

describe("checkShellFile", () => {
  it("passes a well-formed script and fails a broken one", async () => {
    const good = await file("ok.sh", "#!/bin/sh\nif [ -f x ]; then echo y; fi\n");
    const okOut = await checkShellFile(good);
    if (okOut.checker === "none") {
      expect(okOut.ok).toBeNull();
      return;
    }
    expect(okOut.ok).toBe(true);
    const bad = await file("bad.sh", "if [ -f x ]; then echo y\n");
    const badOut = await checkShellFile(bad);
    expect(badOut.ok).toBe(false);
    expect(badOut.error).toMatch(/syntax error/i);
  });
});

/**
 * A scripted runner: each entry answers the calls whose `cmd args...`
 * starts with its key. Unscripted binaries are missing (ENOENT).
 */
function fakeRunner(script: Record<string, Partial<CheckerRun>>): {
  run: CheckerRunner;
  calls: string[];
  envs: (Readonly<Record<string, string | undefined>> | undefined)[];
} {
  const calls: string[] = [];
  const envs: (Readonly<Record<string, string | undefined>> | undefined)[] = [];
  const keys = Object.keys(script).sort((a, b) => b.length - a.length);
  const run: CheckerRunner = async (cmd, args, options) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    envs.push(options?.env);
    const key = keys.find((k) => line === k || line.startsWith(`${k} `));
    const answer = key === undefined ? undefined : script[key];
    if (answer === undefined) {
      return { exitCode: null, stdout: "", stderr: "spawn ENOENT", missing: true, timedOut: false };
    }
    return { exitCode: 0, stdout: "", stderr: "", missing: false, timedOut: false, ...answer };
  };
  return { run, calls, envs };
}

const PY_PROBE = "-c import sys; sys.stdout.write(str(sys.version_info[0]))";
const STORE_STUB: Partial<CheckerRun> = {
  exitCode: 9009,
  stderr: "Python was not found; run without arguments to install from the Microsoft Store",
};

describe("checkPythonFile with a broken python3 (Windows Store alias)", () => {
  it("skips the stub and checks with the next working interpreter", async () => {
    const { run, calls } = fakeRunner({
      [`python3 ${PY_PROBE}`]: STORE_STUB,
      python3: STORE_STUB,
      [`python ${PY_PROBE}`]: { stdout: "3" },
      python: { exitCode: 0 },
    });
    const out = await checkPythonFile("C:\\w\\a.py", { run, platform: "win32" });
    expect(out).toMatchObject({ ok: true, checker: "python compile()" });
    expect(calls.filter((c) => c.includes("compile(")).every((c) => c.startsWith("python "))).toBe(true);
  });

  it("falls back to `py -3` on Windows", async () => {
    const { run } = fakeRunner({
      [`python3 ${PY_PROBE}`]: STORE_STUB,
      [`python ${PY_PROBE}`]: STORE_STUB,
      [`py -3 ${PY_PROBE}`]: { stdout: "3" },
      "py -3": { exitCode: 0 },
    });
    const out = await checkPythonFile("C:\\w\\a.py", { run, platform: "win32" });
    expect(out).toMatchObject({ ok: true, checker: "py -3 compile()" });
  });

  it("does not try `py` off Windows", async () => {
    const { run, calls } = fakeRunner({ [`py -3 ${PY_PROBE}`]: { stdout: "3" } });
    const out = await checkPythonFile("/w/a.py", { run, platform: "linux" });
    expect(out).toMatchObject({ ok: null, checker: "none", error: "no working Python 3 found" });
    expect(calls.some((c) => c.startsWith("py "))).toBe(false);
  });

  it("rejects Python 2", async () => {
    const { run } = fakeRunner({ [`python3 ${PY_PROBE}`]: { stdout: "2" } });
    const out = await checkPythonFile("/w/a.py", { run, platform: "linux" });
    expect(out).toMatchObject({ ok: null, checker: "none" });
  });

  it("reports unchecked, not failed, when only the stub exists", async () => {
    const { run } = fakeRunner({ [`python3 ${PY_PROBE}`]: STORE_STUB, python3: STORE_STUB });
    const out = await checkPythonFile("C:\\w\\a.py", { run, platform: "win32" });
    expect(out).toMatchObject({ ok: null, checker: "none", error: "no working Python 3 found" });
  });

  it("still fails a real SyntaxError", async () => {
    const { run } = fakeRunner({
      [`python3 ${PY_PROBE}`]: { stdout: "3" },
      python3: { exitCode: 1, stderr: '  File "a.py", line 1\n    def f(x)\nSyntaxError: expected \':\'' },
    });
    const out = await checkPythonFile("/w/a.py", { run, platform: "linux" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/SyntaxError/);
  });

  it("reports unchecked when compile exits non-zero without a SyntaxError", async () => {
    const { run } = fakeRunner({
      [`python3 ${PY_PROBE}`]: { stdout: "3" },
      python3: { exitCode: 1, stderr: "PermissionError: [Errno 13] Permission denied: 'a.py'" },
    });
    const out = await checkPythonFile("/w/a.py", { run, platform: "linux" });
    expect(out).toMatchObject({ ok: null, checker: "python3 compile()" });
    expect(out.error).toContain("python3 compile() did not run");
  });

  it("probes once and reuses the interpreter it found", async () => {
    const { run, calls } = fakeRunner({ [`python3 ${PY_PROBE}`]: { stdout: "3" }, python3: {} });
    await checkPythonFile("/w/a.py", { run, platform: "linux" });
    await checkPythonFile("/w/b.py", { run, platform: "linux" });
    expect(calls.filter((c) => c.includes("version_info"))).toHaveLength(1);
  });

  it("probes again after finding nothing", async () => {
    const { run, calls } = fakeRunner({});
    await checkPythonFile("/w/a.py", { run, platform: "linux" });
    await checkPythonFile("/w/b.py", { run, platform: "linux" });
    expect(calls.filter((c) => c.includes("version_info"))).toHaveLength(4);
  });
});

const WSL_STUB: Partial<CheckerRun> = {
  exitCode: 1,
  stderr: "<3>WSL (14 - Relay) ERROR: CreateProcessCommon:640: execvpe(/bin/bash) failed: No such file or directory",
};

describe("checkShellFile with a broken bash (WSL launcher)", () => {
  it("prefers sh on Windows and never runs the WSL bash", async () => {
    const { run, calls } = fakeRunner({
      "bash -c exit 0": WSL_STUB,
      bash: WSL_STUB,
      "sh -c exit 0": {},
      sh: {},
    });
    const out = await checkShellFile("C:\\w\\a.sh", { run, platform: "win32" });
    expect(out).toMatchObject({ ok: true, checker: "sh -n" });
    expect(calls.some((c) => c.startsWith("bash"))).toBe(false);
  });

  it("skips a bash that fails the probe and uses sh", async () => {
    const { run } = fakeRunner({ "bash -c exit 0": WSL_STUB, bash: WSL_STUB, "sh -c exit 0": {}, sh: {} });
    const out = await checkShellFile("/w/a.sh", { run, platform: "linux" });
    expect(out).toMatchObject({ ok: true, checker: "sh -n" });
  });

  it("keeps bash first off Windows", async () => {
    const { run } = fakeRunner({ "bash -c exit 0": {}, bash: {}, "sh -c exit 0": {}, sh: {} });
    const out = await checkShellFile("/w/a.sh", { run, platform: "darwin" });
    expect(out).toMatchObject({ ok: true, checker: "bash -n" });
  });

  it("reports unchecked, not failed, when only the WSL stub exists", async () => {
    const { run } = fakeRunner({ "bash -c exit 0": WSL_STUB, bash: WSL_STUB });
    const out = await checkShellFile("C:\\w\\a.sh", { run, platform: "win32" });
    expect(out).toMatchObject({ ok: null, checker: "none", error: "no working shell found" });
  });

  it("still fails a real syntax error", async () => {
    const { run } = fakeRunner({
      "bash -c exit 0": {},
      bash: { exitCode: 2, stderr: "a.sh: line 2: syntax error: unexpected end of file" },
    });
    const out = await checkShellFile("/w/a.sh", { run, platform: "linux" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/syntax error/);
  });

  it("reports unchecked when -n exits non-zero without a syntax error", async () => {
    const { run } = fakeRunner({
      "bash -c exit 0": {},
      bash: { exitCode: 127, stderr: "bash: C:\\w\\a.sh: No such file or directory" },
    });
    const out = await checkShellFile("/w/a.sh", { run, platform: "linux" });
    expect(out).toMatchObject({ ok: null, checker: "bash -n" });
    expect(out.error).toContain("bash -n did not run");
  });
});

describe("checker verdicts", () => {
  it("fails a dash-style capital `Syntax error:`", async () => {
    const { run } = fakeRunner({
      "sh -c exit 0": {},
      sh: { exitCode: 2, stderr: "q.sh: 2: Syntax error: Unterminated quoted string" },
    });
    const out = await checkShellFile("/w/a.sh", { run, platform: "win32" });
    expect(out).toMatchObject({ ok: false, checker: "sh -n" });
  });

  it("runs the probe and the check in the C locale", async () => {
    // Under LANG=de_DE bash would say "Syntaxfehler", which no pattern
    // matches; the runner must be asked for the C locale every time.
    const { run, envs } = fakeRunner({
      "bash -c exit 0": {},
      bash: { exitCode: 2, stderr: "a.sh: line 2: syntax error: unexpected end of file" },
      [`python3 ${PY_PROBE}`]: { stdout: "3" },
      python3: {},
    });
    await checkShellFile("/w/a.sh", { run, platform: "linux" });
    await checkPythonFile("/w/a.py", { run, platform: "linux" });
    expect(envs).toHaveLength(4);
    for (const env of envs) {
      expect(env).toMatchObject({ LC_ALL: "C" });
      expect(env !== undefined && "LANGUAGE" in env && env.LANGUAGE === undefined).toBe(true);
    }
    // Shell probe + check, then Python probe + check.
    expect(envs.map((env) => env?.PYTHONUTF8)).toEqual([undefined, undefined, "1", "1"]);
  });

  it.skipIf(process.platform === "win32")(
    "runChecker sets LC_ALL and unsets LANGUAGE in the real child env",
    async () => {
      const saved = process.env.LANGUAGE;
      process.env.LANGUAGE = "de_DE:de";
      try {
        const out = await runChecker("sh", ["-c", 'printf %s "${LANGUAGE-unset}:$LC_ALL"'], {
          env: { LC_ALL: "C", LANGUAGE: undefined },
        });
        expect(out.stdout).toBe("unset:C");
      } finally {
        if (saved === undefined) delete process.env.LANGUAGE;
        else process.env.LANGUAGE = saved;
      }
    },
  );

  it("does not take a keyword in the file path for a syntax error", async () => {
    const shellPath = "/w/unexpected/syntax error/a.sh";
    const { run } = fakeRunner({
      "bash -c exit 0": {},
      bash: { exitCode: 126, stderr: `bash: ${shellPath}: Permission denied` },
      [`python3 ${PY_PROBE}`]: { stdout: "3" },
      python3: { exitCode: 1, stderr: "PermissionError: [Errno 13] Permission denied: '/w/SyntaxError/a.py'" },
    });
    const sh = await checkShellFile(shellPath, { run, platform: "linux" });
    expect(sh).toMatchObject({ ok: null, checker: "bash -n" });
    const py = await checkPythonFile("/w/SyntaxError/a.py", { run, platform: "linux" });
    expect(py).toMatchObject({ ok: null, checker: "python3 compile()" });
  });

  it("reports a timed-out check as unchecked", async () => {
    const { run } = fakeRunner({
      "bash -c exit 0": {},
      bash: { exitCode: null, timedOut: true },
      [`python3 ${PY_PROBE}`]: { stdout: "3" },
      python3: { exitCode: null, timedOut: true },
    });
    expect(await checkShellFile("/w/a.sh", { run, platform: "linux" })).toMatchObject({
      ok: null,
      checker: "bash -n",
      error: "timed out",
    });
    expect(await checkPythonFile("/w/a.py", { run, platform: "linux" })).toMatchObject({
      ok: null,
      checker: "python3 compile()",
      error: "timed out",
    });
  });

  it("probes again once a found interpreter goes missing", async () => {
    let gone = false;
    const calls: string[] = [];
    const run: CheckerRunner = async (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      calls.push(line);
      if (gone && cmd === "bash") {
        return { exitCode: null, stdout: "", stderr: "spawn bash ENOENT", missing: true, timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", missing: false, timedOut: false };
    };
    expect(await checkShellFile("/w/a.sh", { run, platform: "linux" })).toMatchObject({ ok: true, checker: "bash -n" });
    gone = true;
    expect(await checkShellFile("/w/b.sh", { run, platform: "linux" })).toMatchObject({ ok: null, checker: "bash -n" });
    expect(await checkShellFile("/w/c.sh", { run, platform: "linux" })).toMatchObject({ ok: true, checker: "sh -n" });
    expect(calls.filter((c) => c.endsWith("-c exit 0"))).toEqual(["bash -c exit 0", "bash -c exit 0", "sh -c exit 0"]);
  });
});
