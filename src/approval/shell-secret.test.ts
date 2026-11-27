import { describe, expect, it } from "vitest";

import {
  checkShellSecretValue,
  describeShellSecretPrompt,
  normalizeShellSecretLabel,
  SHELL_SECRET_MAX_CHARS,
} from "./shell-secret.js";

/** ATO-2486: what a person may type for a job's password, and how it is asked. */
describe("checkShellSecretValue", () => {
  it("keeps the value, inner spaces too, and drops one trailing line break", () => {
    expect(checkShellSecretValue("correct horse 42!")).toEqual({ ok: true, value: "correct horse 42!" });
    expect(checkShellSecretValue("pw\n")).toEqual({ ok: true, value: "pw" });
    expect(checkShellSecretValue("pw\r\n")).toEqual({ ok: true, value: "pw" });
  });

  it("refuses what cannot be one line of input, naming the problem, never the value", () => {
    for (const raw of [undefined, 42, "", "\n", "a\nb", "a\u0000b", "x".repeat(SHELL_SECRET_MAX_CHARS + 1)]) {
      const checked = checkShellSecretValue(raw);
      expect(checked.ok, JSON.stringify(raw)).toBe(false);
      if (!checked.ok && typeof raw === "string" && raw.length > 2) {
        expect(checked.reason).not.toContain(raw);
      }
    }
  });
});

describe("normalizeShellSecretLabel", () => {
  it("is one bounded line and never empty", () => {
    expect(normalizeShellSecretLabel("  sudo\n password ")).toBe("sudo password");
    expect(normalizeShellSecretLabel(true)).toBe("a password");
    expect(normalizeShellSecretLabel("")).toBe("a password");
    expect(normalizeShellSecretLabel("x".repeat(500)).length).toBe(120);
  });
});

describe("describeShellSecretPrompt", () => {
  it("says who asks, for what, and where to type it", () => {
    const text = describeShellSecretPrompt({
      jobId: 2,
      label: "sudo password",
      commandLine: "sudo apt update",
      promptLine: "[sudo] password for me:",
    });
    expect(text).toContain("Job 2 (sudo apt update) asks for sudo password.");
    expect(text).toContain("It printed: [sudo] password for me:");
    expect(text).toContain("The agent never sees it.");
  });
});
