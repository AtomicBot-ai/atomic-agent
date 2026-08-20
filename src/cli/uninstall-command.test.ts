import { describe, expect, it } from "vitest";
import { parseUninstallArgs } from "./uninstall-command.js";

describe("parseUninstallArgs", () => {
  it("defaults to app + path — the state directory is never implied", () => {
    const parsed = parseUninstallArgs([]);
    expect([...parsed.scopes].sort()).toEqual(["app", "path"]);
    expect(parsed.scopes).not.toContain("state");
  });

  it("--all selects every scope", () => {
    const parsed = parseUninstallArgs(["--all"]);
    expect([...parsed.scopes].sort()).toEqual(["app", "path", "state"]);
  });

  it("named scopes replace the default set", () => {
    const parsed = parseUninstallArgs(["--state"]);
    expect(parsed.scopes).toEqual(["state"]);
  });

  it("accepts repeated scopes without duplicating them", () => {
    const parsed = parseUninstallArgs(["--app", "--app", "--path"]);
    expect([...parsed.scopes].sort()).toEqual(["app", "path"]);
  });

  it("parses --dry-run and both spellings of --yes", () => {
    expect(parseUninstallArgs(["--dry-run"]).dryRun).toBe(true);
    expect(parseUninstallArgs(["--yes"]).yes).toBe(true);
    expect(parseUninstallArgs(["-y"]).yes).toBe(true);
  });

  it("reports an unknown option instead of guessing at it", () => {
    const parsed = parseUninstallArgs(["--everything"]);
    expect(parsed.error).toContain("--everything");
  });

  it("recognises the help flags", () => {
    expect(parseUninstallArgs(["--help"]).help).toBe(true);
    expect(parseUninstallArgs(["-h"]).help).toBe(true);
  });

  it("combines scopes with flags", () => {
    const parsed = parseUninstallArgs(["--all", "--dry-run", "-y"]);
    expect([...parsed.scopes].sort()).toEqual(["app", "path", "state"]);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.yes).toBe(true);
  });
});
