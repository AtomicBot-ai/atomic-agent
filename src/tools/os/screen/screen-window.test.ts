import { describe, expect, it } from "vitest";
import { parseWindow } from "./screen-host.js";
import {
  describeWindows,
  parseWindowQuery,
  pickWindow,
  windowCaptureRefusal,
  windowLabel,
  windowScreencaptureArgs,
  type ScreenWindow,
} from "./screen-window.js";

function win(over: Partial<ScreenWindow>): ScreenWindow {
  return { id: 1, pid: 10, app: "TextEdit", bundleId: "com.apple.TextEdit", title: "", x: 0, y: 25, width: 800, height: 600, ...over };
}

const desk = [
  win({ id: 11, app: "Xcode", bundleId: "com.apple.dt.Xcode", title: "App.swift" }),
  win({ id: 12, app: "Code", bundleId: "com.microsoft.VSCode", title: "main.ts — repo" }),
  win({ id: 13, app: "Safari", bundleId: "com.apple.Safari", title: "Docs" }),
  win({ id: 14, app: "Safari", bundleId: "com.apple.Safari", title: "Error page" }),
];

describe("pickWindow", () => {
  it("takes the front-most window of the app", () => {
    expect(pickWindow(desk, { app: "safari" })?.id).toBe(13);
  });

  it("prefers an exact app name over a substring", () => {
    expect(pickWindow(desk, { app: "code" })?.id).toBe(12);
  });

  it("matches a bundle id and narrows by title", () => {
    expect(pickWindow(desk, { app: "com.apple.Safari", window: "error" })?.id).toBe(14);
  });

  it("takes a title alone, front to back", () => {
    expect(pickWindow(desk, { window: "app.swift" })?.id).toBe(11);
  });

  it("answers null when nothing matches", () => {
    expect(pickWindow(desk, { app: "Figma" })).toBeNull();
    expect(pickWindow(desk, { app: "Safari", window: "nope" })).toBeNull();
  });
});

describe("window query and labels", () => {
  it("reads app and window, treating null and blank as omitted", () => {
    expect(parseWindowQuery({})).toBeUndefined();
    expect(parseWindowQuery({ app: null, window: "  " })).toBeUndefined();
    expect(parseWindowQuery({ app: " Notes ", window: null })).toEqual({ app: "Notes" });
    expect(() => parseWindowQuery({ app: 3 })).toThrow(/`app` must be a string/);
  });

  it("lists windows front to back and caps the list", () => {
    expect(describeWindows([])).toBe("no app windows are on screen");
    expect(describeWindows(desk, 2)).toBe(
      '- Xcode — "App.swift" (com.apple.dt.Xcode)\n- Code — "main.ts — repo" (com.microsoft.VSCode)\n- … and 2 more',
    );
    expect(windowLabel(win({ app: null, bundleId: null, title: "" }))).toBe("unknown app");
  });

  it("builds the screencapture argv for one window", () => {
    expect(windowScreencaptureArgs("/a.jpg", 42)).toEqual(["-x", "-o", "-t", "jpg", "-l", "42", "/a.jpg"]);
  });

  it("parses window entries and drops malformed ones", () => {
    expect(parseWindow({ id: 5, pid: 9, app: "Notes", bundleId: "com.apple.Notes", title: "x", x: 0, y: 0, width: 10, height: 10 })).toHaveLength(1);
    expect(parseWindow({ id: 5, pid: 9, x: 0, y: 0, width: 0, height: 10 })).toEqual([]);
    expect(parseWindow("junk")).toEqual([]);
    expect(parseWindow({ id: 5, pid: 9, x: 0, y: 0, width: 4, height: 4 })[0]).toMatchObject({ app: null, bundleId: null, title: "" });
  });
});

describe("windowCaptureRefusal", () => {
  it("refuses password managers and the login and security prompts", () => {
    expect(windowCaptureRefusal("com.1password.1password")).toContain("never captured");
    expect(windowCaptureRefusal("com.apple.SecurityAgent")).not.toBeNull();
    expect(windowCaptureRefusal("com.apple.keychainaccess")).not.toBeNull();
  });

  it("lets browsers and terminals be captured: a snapshot only looks", () => {
    expect(windowCaptureRefusal("com.apple.Safari")).toBeNull();
    expect(windowCaptureRefusal("com.googlecode.iterm2")).toBeNull();
    expect(windowCaptureRefusal(null)).toBeNull();
  });
});
