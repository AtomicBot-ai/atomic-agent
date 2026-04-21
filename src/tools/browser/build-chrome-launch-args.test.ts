import { describe, expect, it } from "vitest";
import { buildChromeLaunchArgs } from "./build-chrome-launch-args.js";

describe("buildChromeLaunchArgs", () => {
  const base = {
    cdpPort: 19222,
    userDataDir: "/tmp/atomic-profile",
    headless: false,
  };

  it("includes the CDP port and user-data-dir in the exact form Chrome expects", () => {
    const args = buildChromeLaunchArgs({ ...base, platform: "darwin" });
    expect(args).toContain("--remote-debugging-port=19222");
    expect(args).toContain("--user-data-dir=/tmp/atomic-profile");
  });

  it("never enables automation-detection flags", () => {
    const args = buildChromeLaunchArgs({ ...base, platform: "darwin" });
    // These are the flags that trip navigator.webdriver + the "being
    // controlled by automated test software" banner. Their absence is
    // the entire point of the openclaw-style stealth path.
    expect(args).not.toContain("--enable-automation");
    expect(args).not.toContain("--disable-blink-features=AutomationControlled");
    expect(args).not.toContain("--remote-debugging-pipe");
    expect(
      args.some((a) => a.includes("AutomationControlled")),
    ).toBe(false);
  });

  it("adds headless + disable-gpu when headless is true", () => {
    const args = buildChromeLaunchArgs({
      ...base,
      headless: true,
      platform: "darwin",
    });
    expect(args).toContain("--headless=new");
    expect(args).toContain("--disable-gpu");
  });

  it("does not include --disable-dev-shm-usage on macOS", () => {
    const args = buildChromeLaunchArgs({ ...base, platform: "darwin" });
    expect(args).not.toContain("--disable-dev-shm-usage");
  });

  it("adds --disable-dev-shm-usage on linux (shm is often too small in containers)", () => {
    const args = buildChromeLaunchArgs({ ...base, platform: "linux" });
    expect(args).toContain("--disable-dev-shm-usage");
  });

  it("opts into no-sandbox only when explicitly requested", () => {
    const withSandbox = buildChromeLaunchArgs({ ...base, platform: "linux" });
    expect(withSandbox).not.toContain("--no-sandbox");
    const noSandbox = buildChromeLaunchArgs({
      ...base,
      platform: "linux",
      noSandbox: true,
    });
    expect(noSandbox).toContain("--no-sandbox");
    expect(noSandbox).toContain("--disable-setuid-sandbox");
  });

  it("appends extraArgs after the base set so callers can override", () => {
    const args = buildChromeLaunchArgs({
      ...base,
      platform: "darwin",
      extraArgs: ["--lang=en-US", "--window-size=1280,800"],
    });
    expect(args).toContain("--lang=en-US");
    expect(args).toContain("--window-size=1280,800");
    const baseLen = buildChromeLaunchArgs({
      ...base,
      platform: "darwin",
    }).length;
    expect(args.length).toBe(baseLen + 2);
  });
});
