import { describe, expect, it } from "vitest";
import { detectChromeMajorVersion, parseMajor } from "./chrome-version.js";

describe("detectChromeMajorVersion (ATO-969)", () => {
  it("reads the macOS bundle version from Info.plist", () => {
    const seen: string[] = [];
    const major = detectChromeMajorVersion(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      {
        platform: "darwin",
        readFile: (file) => {
          seen.push(file);
          return "<dict><key>CFBundleShortVersionString</key>\n\t<string>142.0.7444.60</string></dict>";
        },
      },
    );
    expect(major).toBe(142);
    expect(seen).toEqual(["/Applications/Google Chrome.app/Contents/Info.plist"]);
  });

  it("picks the newest version folder next to chrome.exe on Windows", () => {
    const major = detectChromeMajorVersion(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      {
        platform: "win32",
        readDir: () => ["141.0.7390.123", "142.0.7444.60", "SetupMetrics", "chrome.exe"],
      },
    );
    expect(major).toBe(142);
  });

  it("asks the binary on Linux", () => {
    expect(
      detectChromeMajorVersion("/usr/bin/google-chrome", {
        platform: "linux",
        runVersion: () => "Google Chrome 142.0.7444.59 \n",
      }),
    ).toBe(142);
  });

  it("returns null instead of throwing when nothing can be read", () => {
    expect(
      detectChromeMajorVersion("/usr/bin/chromium", {
        platform: "linux",
        runVersion: () => {
          throw new Error("ETIMEDOUT");
        },
      }),
    ).toBeNull();
    expect(
      detectChromeMajorVersion("/opt/odd/chrome", { platform: "darwin", readFile: () => "" }),
    ).toBeNull();
  });

  it("ignores numbers that are not a Chrome version", () => {
    expect(parseMajor("Chromium 142.0.7444.59 snap")).toBe(142);
    expect(parseMajor("version 1.2")).toBeNull();
    expect(parseMajor("no digits")).toBeNull();
  });
});
