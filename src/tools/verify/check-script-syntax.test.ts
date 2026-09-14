import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkJavaScriptFile,
  checkPythonFile,
  checkShellFile,
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

describe("checkPythonFile", () => {
  it("compiles without leaving bytecode next to the file", async () => {
    const path = await file("ok.py", "def f(x):\n    return x + 1\n");
    const out = await checkPythonFile(path);
    if (out.checker === "none") {
      expect(out.ok).toBeNull();
      expect(out.error).toBe("python3 not found");
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
    expect(badOut.error).toMatch(/syntax error/);
  });
});
