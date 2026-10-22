import { describe, expect, it } from "vitest";

import {
  detectDesktopSharing,
  type DetectDesktopSharingInput,
} from "./detect-desktop-sharing.js";

/** A fake disk: the paths that exist, and the files that can be read. */
function disk(
  paths: readonly string[],
  files: Readonly<Record<string, string>> = {},
): Pick<DetectDesktopSharingInput, "exists" | "readFile"> {
  const present = new Set([...paths, ...Object.keys(files)]);
  return {
    exists: (path) => present.has(path),
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  };
}

const MAC_RECORD = "/Users/op/Library/Application Support/Atomic Agent/state-dirs.json";

function mac(
  overrides: Partial<DetectDesktopSharingInput> = {},
): DetectDesktopSharingInput {
  return {
    stateDir: "/Users/op/.atomic-agent",
    homeDir: "/Users/op",
    platform: "darwin",
    env: {},
    ...disk([]),
    ...overrides,
  };
}

describe("detectDesktopSharing", () => {
  it("finds nothing on a machine without the desktop app", () => {
    const result = detectDesktopSharing(mac());
    expect(result.signals).toEqual([]);
    expect(result.sharesStateDir).toBe(false);
    expect(result.legacyDir).toBeNull();
    expect(result.stateDir).toBe("/Users/op/.atomic-agent");
  });

  it("finds the desktop through its state-dirs.json record", () => {
    const result = detectDesktopSharing(
      mac(disk([], { [MAC_RECORD]: JSON.stringify({ dirs: ["/Users/op/.atomic-agent"] }) })),
    );
    expect(result.signals).toEqual(["state-dirs-record"]);
    expect(result.sharesStateDir).toBe(true);
  });

  it("matches a recorded path with a trailing slash", () => {
    const result = detectDesktopSharing(
      mac(disk([], { [MAC_RECORD]: JSON.stringify({ dirs: ["/Users/op/.atomic-agent/"] }) })),
    );
    expect(result.sharesStateDir).toBe(true);
  });

  it("ignores a record that lists other folders only", () => {
    const result = detectDesktopSharing(
      mac(disk([], { [MAC_RECORD]: JSON.stringify({ dirs: ["/tmp/smoke-run"] }) })),
    );
    expect(result.signals).toEqual([]);
    expect(result.sharesStateDir).toBe(false);
  });

  it("treats a broken record as not found", () => {
    for (const content of ["{not json", "null", "[]", '{"dirs":"x"}', '{"dirs":[1,null]}']) {
      const result = detectDesktopSharing(mac(disk([], { [MAC_RECORD]: content })));
      expect(result.signals).toEqual([]);
    }
  });

  it("compares against ATOMIC_AGENT_STATE_DIR, not the default folder", () => {
    const record = JSON.stringify({ dirs: ["/Users/op/.atomic-agent"] });
    const custom = detectDesktopSharing(
      mac({ stateDir: "/Volumes/work/agent", ...disk([], { [MAC_RECORD]: record }) }),
    );
    expect(custom.signals).toEqual([]);
    expect(custom.sharesStateDir).toBe(false);

    const recordedCustom = detectDesktopSharing(
      mac({
        stateDir: "/Volumes/work/agent",
        ...disk([], { [MAC_RECORD]: JSON.stringify({ dirs: ["/Volumes/work/agent"] }) }),
      }),
    );
    expect(recordedCustom.sharesStateDir).toBe(true);
  });

  it("finds the app in /Applications or ~/Applications on macOS", () => {
    for (const app of ["/Applications/Atomic Agent.app", "/Users/op/Applications/Atomic Agent.app"]) {
      const result = detectDesktopSharing(mac(disk([app])));
      expect(result.signals).toEqual(["app-installed"]);
      expect(result.sharesStateDir).toBe(true);
    }
  });

  it("does not claim an installed app shares a custom state folder it never recorded", () => {
    const result = detectDesktopSharing(
      mac({ stateDir: "/Volumes/work/agent", ...disk(["/Applications/Atomic Agent.app"]) }),
    );
    expect(result.signals).toEqual(["app-installed"]);
    expect(result.sharesStateDir).toBe(false);
  });

  it("reports the legacy folder without calling it shared", () => {
    const result = detectDesktopSharing(mac(disk(["/Users/op/.atomic-agent-desktop"])));
    expect(result.signals).toEqual(["legacy-dir"]);
    expect(result.sharesStateDir).toBe(false);
    expect(result.legacyDir).toBe("/Users/op/.atomic-agent-desktop");
  });

  it("does not report the legacy folder as left in place when it is the folder being removed", () => {
    const result = detectDesktopSharing(
      mac({ stateDir: "/Users/op/.atomic-agent-desktop", ...disk(["/Users/op/.atomic-agent-desktop"]) }),
    );
    expect(result.legacyDir).toBeNull();
  });

  it("reads %APPDATA% and %LOCALAPPDATA% on Windows, ignoring case", () => {
    const record = "C:\\Users\\op\\AppData\\Roaming\\Atomic Agent\\state-dirs.json";
    const base: DetectDesktopSharingInput = {
      stateDir: "C:\\Users\\op\\.atomic-agent",
      homeDir: "C:\\Users\\op",
      platform: "win32",
      env: {
        APPDATA: "C:\\Users\\op\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\op\\AppData\\Local",
      },
    };
    const recorded = detectDesktopSharing({
      ...base,
      ...disk([], { [record]: JSON.stringify({ dirs: ["c:\\users\\OP\\.atomic-agent"] }) }),
    });
    expect(recorded.signals).toEqual(["state-dirs-record"]);
    expect(recorded.sharesStateDir).toBe(true);

    const installed = detectDesktopSharing({
      ...base,
      ...disk(["C:\\Users\\op\\AppData\\Local\\Programs\\Atomic Agent"]),
    });
    expect(installed.signals).toEqual(["app-installed"]);
    expect(installed.sharesStateDir).toBe(true);
  });

  it("reads $XDG_CONFIG_HOME on Linux and falls back to ~/.config", () => {
    const base: DetectDesktopSharingInput = {
      stateDir: "/home/op/.atomic-agent",
      homeDir: "/home/op",
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/home/op/xdg" },
    };
    const record = JSON.stringify({ dirs: ["/home/op/.atomic-agent"] });
    expect(
      detectDesktopSharing({
        ...base,
        ...disk([], { "/home/op/xdg/Atomic Agent/state-dirs.json": record }),
      }).sharesStateDir,
    ).toBe(true);
    expect(
      detectDesktopSharing({
        ...base,
        env: {},
        ...disk([], { "/home/op/.config/Atomic Agent/state-dirs.json": record }),
      }).sharesStateDir,
    ).toBe(true);
  });

  it("never throws when a probe does", () => {
    const result = detectDesktopSharing(
      mac({
        exists: () => {
          throw new Error("EACCES");
        },
        readFile: () => {
          throw new Error("EACCES");
        },
      }),
    );
    expect(result.signals).toEqual([]);
  });
});
