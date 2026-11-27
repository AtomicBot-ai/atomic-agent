import { describe, expect, it } from "vitest";

import { logbookSkipReason } from "./logbook-skip.js";

describe("logbookSkipReason", () => {
  it("skips password managers, login and security prompts", () => {
    expect(logbookSkipReason({ name: "1Password", bundleId: "com.1password.1password" }, [])).toMatch(/password or login/);
    expect(logbookSkipReason({ name: "loginwindow", bundleId: "com.apple.loginwindow" }, [])).toMatch(/password or login/);
    expect(logbookSkipReason({ name: "Passwords", bundleId: "com.apple.Passwords" }, [])).toMatch(/password or login/);
  });

  it("skips system settings, Atomic Agent itself and script runners", () => {
    expect(logbookSkipReason({ name: "System Settings", bundleId: "com.apple.systempreferences" }, [])).toMatch(/protected/);
    expect(logbookSkipReason({ name: "Atomic Agent", bundleId: "io.atomicagent.desktop" }, [])).toMatch(/protected/);
    expect(logbookSkipReason({ name: "Keyboard Maestro", bundleId: "com.stairways.keyboardmaestro.editor" }, [])).toMatch(/protected/);
  });

  it("skips an app it cannot identify", () => {
    expect(logbookSkipReason(null, [])).toMatch(/could not be identified/);
    expect(logbookSkipReason({ name: "Mystery", bundleId: null }, [])).toMatch(/could not be identified/);
  });

  it("captures ordinary apps, browsers and terminals", () => {
    expect(logbookSkipReason({ name: "TextEdit", bundleId: "com.apple.TextEdit" }, [])).toBeNull();
    expect(logbookSkipReason({ name: "Safari", bundleId: "com.apple.Safari" }, [])).toBeNull();
    expect(logbookSkipReason({ name: "Terminal", bundleId: "com.apple.Terminal" }, [])).toBeNull();
  });

  it("honours the person's excluded apps by bundle id, sub-id or name", () => {
    const slack = { name: "Slack", bundleId: "com.tinyspeck.slackmacgap" };
    expect(logbookSkipReason(slack, ["com.tinyspeck.slackmacgap"])).toMatch(/excluded/);
    expect(logbookSkipReason(slack, ["com.tinyspeck"])).toMatch(/excluded/);
    expect(logbookSkipReason(slack, ["slack"])).toMatch(/excluded/);
    expect(logbookSkipReason(slack, ["com.tiny"])).toBeNull();
  });
});
