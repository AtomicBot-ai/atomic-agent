import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  APP_INSTALL_RECORD,
  appShortcutFolder,
  isAppShortcutPath,
  readAppShortcut,
  removeAppShortcut,
  type ShortcutPlace,
} from "./app-shortcut-paths.js";

const mac = (home: string): ShortcutPlace => ({ platform: "darwin", home, env: {} });
const linux = (home: string, env: NodeJS.ProcessEnv = {}): ShortcutPlace => ({ platform: "linux", home, env });
const win: ShortcutPlace = { platform: "win32", home: "C:\\Users\\nadya", env: { APPDATA: "C:\\Users\\nadya\\AppData\\Roaming" } };

describe("app launcher paths (ATO-2459)", () => {
  it("names one folder per platform, as Chrome's installed apps do", () => {
    expect(appShortcutFolder(mac("/Users/n"))).toBe("/Users/n/Applications/Atomic Apps");
    expect(appShortcutFolder(linux("/home/n"))).toBe("/home/n/.local/share/applications");
    expect(appShortcutFolder(linux("/home/n", { XDG_DATA_HOME: "/data" }))).toBe("/data/applications");
    expect(appShortcutFolder(linux("/home/n", { XDG_DATA_HOME: "relative" }))).toBe("/home/n/.local/share/applications");
    expect(appShortcutFolder(win)).toBe("C:\\Users\\nadya\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Atomic Apps");
    expect(appShortcutFolder({ platform: "aix", home: "/h", env: {} })).toBeNull();
  });

  it("takes a recorded path only inside that folder, with that extension", () => {
    expect(isAppShortcutPath("/Users/n/Applications/Atomic Apps/Fx.app", "fx-a1b2c3", mac("/Users/n"))).toBe(true);
    expect(isAppShortcutPath("/Users/n/Applications/Atomic Apps/../../Documents.app", "fx-a1b2c3", mac("/Users/n"))).toBe(false);
    expect(isAppShortcutPath("/Users/n/Applications/Atomic Apps/.app", "fx-a1b2c3", mac("/Users/n"))).toBe(false);
    expect(isAppShortcutPath("/Users/n/Documents", "fx-a1b2c3", mac("/Users/n"))).toBe(false);
    expect(isAppShortcutPath("/home/n/.local/share/applications/atomic-app-fx-a1b2c3.desktop", "fx-a1b2c3", linux("/home/n"))).toBe(true);
    expect(isAppShortcutPath("/home/n/.local/share/applications/firefox.desktop", "fx-a1b2c3", linux("/home/n"))).toBe(false);
    const lnk = "C:\\Users\\nadya\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Atomic Apps\\Fx.lnk";
    expect(isAppShortcutPath(lnk, "fx-a1b2c3", win)).toBe(true);
    expect(isAppShortcutPath(lnk.replace("Fx.lnk", "Fx.exe"), "fx-a1b2c3", win)).toBe(false);
    expect(isAppShortcutPath(42, "fx-a1b2c3", win)).toBe(false);
  });

  it("removes the recorded launcher and its record, and leaves a forged record's target alone", () => {
    const home = mkdtempSync(join(tmpdir(), "atomic-app-home-"));
    const place = linux(home);
    const app = join(home, "app");
    mkdirSync(app);
    const folder = appShortcutFolder(place)!;
    mkdirSync(folder, { recursive: true });
    const launcher = join(folder, "atomic-app-fx-a1b2c3.desktop");
    writeFileSync(launcher, "[Desktop Entry]\n");
    writeFileSync(join(app, APP_INSTALL_RECORD), JSON.stringify({ path: launcher }));
    expect(readAppShortcut(app, "fx-a1b2c3", place)).toBe(launcher);
    expect(removeAppShortcut(app, "fx-a1b2c3", place)).toBe(true);
    expect(existsSync(launcher)).toBe(false);
    expect(existsSync(join(app, APP_INSTALL_RECORD))).toBe(false);

    const precious = join(home, "precious.txt");
    writeFileSync(precious, "keep");
    writeFileSync(join(app, APP_INSTALL_RECORD), JSON.stringify({ path: precious }));
    expect(removeAppShortcut(app, "fx-a1b2c3", place)).toBe(false);
    expect(existsSync(precious)).toBe(true);
  });
});
