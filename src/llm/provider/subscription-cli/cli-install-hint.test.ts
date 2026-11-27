import { describe, expect, it } from "vitest";

import { cliInstallHint, subscriptionInstallCommand } from "./cli-install-hint.js";
import { SubscriptionCliNotInstalledError } from "./subscription-cli-errors.js";

describe("cliInstallHint (ATO-1679)", () => {
  it("gives a Windows user the PowerShell installer and a claude.exe path", () => {
    const hint = cliInstallHint("claude", "win32");
    expect(hint).toContain("in PowerShell with `irm https://claude.ai/install.ps1 | iex`");
    expect(hint).toContain("restart Atomic Agent");
    expect(hint).toContain("claude.exe");
    expect(hint).not.toContain("curl");
  });

  it("gives macOS and Linux the shell installer", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const hint = cliInstallHint("claude", platform);
      expect(hint).toContain("in Terminal with `curl -fsSL https://claude.ai/install.sh | bash`");
      expect(hint).not.toContain("claude.exe");
    }
  });

  it("names npm, Node.js and codex.cmd for Codex on Windows", () => {
    const hint = cliInstallHint("codex", "win32");
    expect(hint).toContain("`npm install -g @openai/codex`");
    expect(hint).toContain("https://nodejs.org");
    expect(hint).toContain("`codex login`");
    expect(hint).toContain("codex.cmd");
  });

  it("is the whole next step of the not-installed message", () => {
    const err = new SubscriptionCliNotInstalledError("claude", cliInstallHint("claude", "win32"), "Claude Code");
    expect(err.message).toBe(
      `Claude Code isn't installed (the \`claude\` command was not found). ${cliInstallHint("claude", "win32")}`,
    );
  });

  it("keeps the desktop step's command", () => {
    expect(subscriptionInstallCommand("claude", "win32")).toBe("irm https://claude.ai/install.ps1 | iex");
    expect(subscriptionInstallCommand("codex", "darwin")).toBe("npm install -g @openai/codex");
  });
});
