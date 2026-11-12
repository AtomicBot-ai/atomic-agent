import { describe, expect, it } from "vitest";
import { buildChromeLaunchArgs } from "./build-chrome-launch-args.js";
import { HEADLESS_WINDOW_SIZE } from "./web-identity.js";

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
    expect(args.some((a) => a.includes("AutomationControlled"))).toBe(false);
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

  it("gives headless the honest identity and a real-size window (ATO-969)", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
    const args = buildChromeLaunchArgs({
      ...base,
      headless: true,
      platform: "darwin",
      userAgent: ua,
      lang: "ru-RU",
    });
    expect(args).toContain(`--user-agent=${ua}`);
    expect(args).toContain("--lang=ru-RU");
    expect(args).toContain(
      `--window-size=${HEADLESS_WINDOW_SIZE.width},${HEADLESS_WINDOW_SIZE.height}`,
    );
    // Never the old headless, never a timezone override.
    expect(args).not.toContain("--headless");
    expect(args.some((a) => a.toLowerCase().includes("timezone"))).toBe(false);
  });

  it("leaves a headed browser's own UA, language and window alone", () => {
    const args = buildChromeLaunchArgs({
      ...base,
      platform: "darwin",
      userAgent: "Mozilla/5.0 test",
      lang: "ru-RU",
    });
    expect(args.some((a) => a.startsWith("--user-agent="))).toBe(false);
    expect(args.some((a) => a.startsWith("--lang="))).toBe(false);
    expect(args.some((a) => a.startsWith("--window-size="))).toBe(false);
  });

  it("headless without a known version keeps Chrome's own UA", () => {
    const args = buildChromeLaunchArgs({ ...base, headless: true, platform: "linux" });
    expect(args.some((a) => a.startsWith("--user-agent="))).toBe(false);
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
