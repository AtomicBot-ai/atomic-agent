import { describe, expect, it } from "vitest";

import { exitHint } from "./cli-exit-hint.js";
import { mapCliFailure } from "./subscription-cli-errors.js";

const exit127 = (binary: string, stderr: string) =>
  mapCliFailure({
    binary,
    installHint: "",
    authHint: "",
    exitCode: 127,
    stdout: "",
    stderr,
    timedOut: false,
    truncated: false,
    timeoutMs: 1000,
    maxOutputBytes: 4096,
  });

describe("exitHint for a missing Node.js (ATO-1679, CLI-E4)", () => {
  it("tells a Mac user with an npm Claude Code to install Node.js or use the native installer", () => {
    const hint = exitHint("/Users/n/.npm-global/bin/claude", "env: node: No such file or directory", 127, "darwin");
    expect(hint).toContain("could not find `node` on PATH");
    expect(hint).toContain("https://nodejs.org");
    expect(hint).toContain("`curl -fsSL https://claude.ai/install.sh | bash`");
    expect(hint).toContain("restart Atomic Agent");
  });

  it("reads GNU env's curly quotes on Linux", () => {
    expect(exitHint("claude", "/usr/bin/env: \u2018node\u2019: No such file or directory", 127, "linux")).toContain(
      "could not find `node` on PATH",
    );
  });

  it("gives Windows the PowerShell installer", () => {
    const hint = exitHint("C:\\Users\\n\\AppData\\Roaming\\npm\\claude.cmd", "'node' is not recognized as an internal or external command", 1, "win32");
    expect(hint).toContain("`irm https://claude.ai/install.ps1 | iex` in PowerShell");
  });

  it("names Node.js for Codex", () => {
    expect(exitHint("codex", "env: node: No such file or directory", 127, "darwin")).toMatch(/^ The Codex CLI needs Node\.js/);
  });
});

describe("exitHint for exit 127 (ATO-1679, CLI-E4)", () => {
  it("explains an exit 127 the text does not, without the binary's path", () => {
    const hint = exitHint("/home/a/.asdf/shims/claude", "/home/a/.asdf/shims/claude: line 3: asdf: command not found", 127, "linux");
    expect(hint).toContain("Exit code 127 means a program the `claude` launcher needs was not found on PATH.");
    expect(hint).toContain("Reinstall Claude Code with `curl -fsSL https://claude.ai/install.sh | bash`");
    expect(hint).not.toContain(".asdf");
  });

  it("adds nothing to another exit code with the same text", () => {
    expect(exitHint("claude", "asdf: command not found", 1, "linux")).toBe("");
    expect(exitHint("claude", "Segmentation fault")).toBe("");
  });

  it("is what the turn's message ends with", () => {
    const err = exit127("/opt/tools/claude", "env: node: No such file or directory");
    expect(err.message).toMatch(/^"\/opt\/tools\/claude" exited with code 127: env: node: No such file or directory Claude Code was installed with npm/);
    expect(exit127("codex", "").message).toContain("Exit code 127 means a program the `codex` launcher needs");
  });
});
