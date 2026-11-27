import { describe, expect, it } from "vitest";

import { CliOutdatedWarnings, cliOutdatedEvent, cliOutdatedNotice } from "./cli-outdated-notice.js";

/** ATO-2523: the chat line and the once-per-session rule for an outdated subscription CLI. */

const CLAUDE = {
  cli: "claude" as const,
  productName: "Claude Code",
  version: "2.1.0",
  minimum: "2.1.22",
  updateCommands: ["claude update"],
};

describe("cliOutdatedNotice", () => {
  it("names the CLI, its version, the command and the minimum", () => {
    expect(cliOutdatedNotice(CLAUDE)).toBe(
      "Claude Code 2.1.0 is out of date: run `claude update` (Atomic Agent needs 2.1.22 or newer).",
    );
  });

  it("offers each command on a platform with two, and only npm on Windows", () => {
    expect(
      cliOutdatedNotice({ productName: "Codex", version: "0.121.0", minimum: "0.122.0", updateCommands: ["npm install -g @openai/codex@latest", "brew upgrade codex"] }),
    ).toBe("Codex 0.121.0 is out of date: run `npm install -g @openai/codex@latest` or `brew upgrade codex` (Atomic Agent needs 0.122.0 or newer).");
    expect(
      cliOutdatedNotice({ productName: "Codex", version: "0.121.0", minimum: "0.122.0", updateCommands: ["npm install -g @openai/codex@latest"] }),
    ).not.toContain("brew");
  });

  it("has no long dash", () => {
    expect(cliOutdatedNotice(CLAUDE)).not.toMatch(/—/);
  });
});

describe("cliOutdatedEvent", () => {
  it("is said once per session and CLI", () => {
    const warnings = new CliOutdatedWarnings();
    expect(cliOutdatedEvent(CLAUDE, warnings, "s1", 0)).toEqual({ type: "cli_outdated", stepIndex: 0, ...CLAUDE });
    expect(cliOutdatedEvent(CLAUDE, warnings, "s1", 3)).toBeNull();
    expect(cliOutdatedEvent(CLAUDE, warnings, "s2", 0)).not.toBeNull();
    expect(cliOutdatedEvent({ ...CLAUDE, cli: "codex", productName: "Codex" }, warnings, "s1", 1)).not.toBeNull();
  });

  it("says nothing for a completion without the mark", () => {
    expect(cliOutdatedEvent(undefined, new CliOutdatedWarnings(), "s1", 0)).toBeNull();
  });
});
