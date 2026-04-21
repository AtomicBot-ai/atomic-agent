import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decorateChromeProfile,
  markChromeProfileCleanExit,
} from "./decorate-chrome-profile.js";

describe("decorateChromeProfile", () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "atomic-profile-"));
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("creates Local State and Default/Preferences from scratch", () => {
    decorateChromeProfile(userDataDir, { profileName: "tester" });

    const localState = JSON.parse(
      readFileSync(join(userDataDir, "Local State"), "utf8"),
    );
    expect(localState.profile.info_cache.Default.name).toBe("tester");
    expect(localState.profile.info_cache.Default.shortcut_name).toBe("tester");

    const prefs = JSON.parse(
      readFileSync(join(userDataDir, "Default", "Preferences"), "utf8"),
    );
    expect(prefs.profile.name).toBe("tester");
    expect(prefs.profile.exit_type).toBe("Normal");
    expect(prefs.profile.exited_cleanly).toBe(true);
  });

  it("preserves unrelated keys when decorating an existing profile", () => {
    mkdirSync(join(userDataDir, "Default"), { recursive: true });
    writeFileSync(
      join(userDataDir, "Local State"),
      JSON.stringify({ existing_top_level: "keep me", profile: { other: 1 } }),
    );
    writeFileSync(
      join(userDataDir, "Default", "Preferences"),
      JSON.stringify({ bookmarks: { version: 7 }, profile: { other: 2 } }),
    );

    decorateChromeProfile(userDataDir);

    const localState = JSON.parse(
      readFileSync(join(userDataDir, "Local State"), "utf8"),
    );
    expect(localState.existing_top_level).toBe("keep me");
    expect(localState.profile.other).toBe(1);

    const prefs = JSON.parse(
      readFileSync(join(userDataDir, "Default", "Preferences"), "utf8"),
    );
    expect(prefs.bookmarks.version).toBe(7);
    expect(prefs.profile.other).toBe(2);
    expect(prefs.profile.exit_type).toBe("Normal");
  });

  it("markChromeProfileCleanExit is a no-op when Preferences does not yet exist", () => {
    expect(() => markChromeProfileCleanExit(userDataDir)).not.toThrow();
    expect(existsSync(join(userDataDir, "Default", "Preferences"))).toBe(false);
  });

  it("markChromeProfileCleanExit flips Crashed → Normal for an existing profile", () => {
    decorateChromeProfile(userDataDir);
    const prefsPath = join(userDataDir, "Default", "Preferences");
    const prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
    prefs.profile.exit_type = "Crashed";
    prefs.profile.exited_cleanly = false;
    writeFileSync(prefsPath, JSON.stringify(prefs));

    markChromeProfileCleanExit(userDataDir);

    const updated = JSON.parse(readFileSync(prefsPath, "utf8"));
    expect(updated.profile.exit_type).toBe("Normal");
    expect(updated.profile.exited_cleanly).toBe(true);
  });
});
