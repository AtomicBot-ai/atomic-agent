import { describe, expect, it } from "vitest";
import {
  mentionsSensitiveHomeEntry,
  sensitiveWriteReason,
  sensitiveWriteTargets,
} from "./sensitive-write-targets.js";

const HOME = "/home/nadia";

describe("sensitiveWriteTargets (ATO-2505)", () => {
  it.each([
    "/home/nadia/.ssh/authorized_keys",
    "/home/nadia/.ssh",
    "/home/nadia/.bashrc",
    "/home/nadia/.zshrc",
    "/home/nadia/.profile",
    "/home/nadia/.config/fish/config.fish",
    "/home/nadia/.config/autostart/x.desktop",
    "/home/nadia/.config/systemd/user/x.service",
    "/home/nadia/Library/LaunchAgents/com.x.plist",
    "/home/nadia/.gitconfig",
    "/home/nadia/.aws/credentials",
    "/home/nadia/Documents/PowerShell/Microsoft.PowerShell_profile.ps1",
    "/home/nadia/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/run.bat",
    "/home/nadia/.BASHRC",
    // Review round 1: home itself, the destination of `cp x/.bashrc ~/`.
    "/home/nadia",
    "/home/nadia/",
  ])("is sensitive: %s", (path) => {
    expect(sensitiveWriteTargets([path], "/tmp/project", HOME)).toEqual([path]);
  });

  it("resolves a relative path against cwd", () => {
    expect(sensitiveWriteTargets([".ssh/authorized_keys"], HOME, HOME)).toEqual([".ssh/authorized_keys"]);
  });

  it.each([
    "/home/nadia/project/.bashrc",
    "/home/nadia/.bashrc.bak",
    "/home/nadia/.sshd/notes",
    "/home/nadia/notes.txt",
    "/tmp/.bashrc",
    "/home/other/.bashrc",
  ])("is not sensitive: %s", (path) => {
    expect(sensitiveWriteTargets([path], "/tmp/project", HOME)).toEqual([]);
  });

  it("names up to three files on the card", () => {
    const reason = sensitiveWriteReason(["a", "b", "c", "d", "e"]);
    expect(reason).toContain("(a, b, c and 2 more)");
    expect(reason).toContain("asks in every mode");
  });

  it.each([
    "echo k >> ~/.ssh/authorized_keys; : $(true)",
    "cp x C:\\Users\\n\\.BASHRC",
    "echo calc > \"%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.bat\"",
    "echo k >> ~/.ss?/authorized_keys",
    "tee -a $HOME/Library/LaunchAgents/x.plist",
  ])("names a sensitive home entry: %s", (line) => {
    expect(mentionsSensitiveHomeEntry(line)).toBe(true);
  });

  it.each(["echo $(date) > notes.txt", "aws --profile dev s3 ls", "cat project/.sshd.conf", "grep x README.md"])(
    "names none: %s",
    (line) => {
      expect(mentionsSensitiveHomeEntry(line)).toBe(false);
    },
  );
});
