import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkLanguageFile,
  LANGUAGE_SYNTAX_EXTENSIONS,
} from "./check-language-syntax.js";
import { verifySyntax } from "./verify-syntax.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atag-verify-lang-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
}

describe("checkLanguageFile", () => {
  it("covers Go, Ruby, PHP, Lua and zsh", () => {
    expect([...LANGUAGE_SYNTAX_EXTENSIONS].sort()).toEqual([
      ".go",
      ".lua",
      ".php",
      ".rb",
      ".zsh",
    ]);
  });

  it("reports unchecked, never passing, when the toolchain is missing", async () => {
    const path = await file("main.go", "package main\n");
    const out = await checkLanguageFile(path, ".go", { cmd: "atag-no-such-gofmt-xyz" });
    expect(out).toMatchObject({ ok: null, checker: "none", error: "gofmt not found" });
  });

  it.skipIf(process.platform === "win32")(
    "fails with the tool's own message, read from stdout as well as stderr",
    async () => {
      // php -l prints its parse error on stdout.
      const fake = await file(
        "fake-php",
        "#!/bin/sh\necho 'PHP Parse error: syntax error, unexpected end of file on line 3'\nexit 255\n",
      );
      await chmod(fake, 0o755);
      const path = await file("index.php", "<?php if (true) {\n");
      const out = await checkLanguageFile(path, ".php", { cmd: fake });
      expect(out.ok).toBe(false);
      expect(out.checker).toBe("php -l");
      expect(out.error).toContain("unexpected end of file");
    },
  );

  it("checks a zsh script with zsh -n when zsh is installed", async () => {
    const good = await file("ok.zsh", "if [[ -n $HOME ]]; then print ok; fi\n");
    const okOut = await checkLanguageFile(good, ".zsh");
    if (okOut.checker === "none") {
      expect(okOut.error).toBe("zsh not found");
      return;
    }
    expect(okOut.ok).toBe(true);
    const bad = await file("bad.zsh", "if [[ -n $HOME ]]; then print ok\n");
    const badOut = await checkLanguageFile(bad, ".zsh");
    expect(badOut.ok).toBe(false);
    expect(await readdir(dir)).toEqual(["bad.zsh", "ok.zsh"]);
  });
});

describe("verify.syntax routing", () => {
  it("sends .go and .rb files to their checkers instead of 'no checker'", async () => {
    await file("main.go", "package main\n\nfunc main() {}\n");
    await file("app.rb", "puts 1\n");
    const report = await verifySyntax(["main.go", "app.rb"], dir);
    for (const result of report.results) {
      expect(result.error ?? "").not.toMatch(/^no checker for/);
      if (result.checker === "none") expect(result.ok).toBeNull();
    }
  });
});
