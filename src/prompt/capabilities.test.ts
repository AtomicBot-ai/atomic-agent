import { describe, expect, it } from "vitest";

import {
  probeClipboard,
  probeNotifications,
  probeWmctrl,
  type WhichRunner,
} from "./capabilities.js";

/** Build a `which` runner that only reports the given bins as present. */
function whichFor(...present: string[]): WhichRunner {
  const set = new Set(present);
  return async (bin: string) => set.has(bin);
}

describe("probeClipboard (linux)", () => {
  it("is true when xclip is present", async () => {
    expect(await probeClipboard("linux", whichFor("xclip"))).toBe(true);
  });

  it("is true when only wl-copy is present (Wayland)", async () => {
    expect(await probeClipboard("linux", whichFor("wl-copy"))).toBe(true);
  });

  it("is false when no clipboard binary is present", async () => {
    expect(await probeClipboard("linux", whichFor())).toBe(false);
  });
});

describe("probeWmctrl", () => {
  it("probes `which wmctrl` on linux", async () => {
    expect(await probeWmctrl("linux", whichFor("wmctrl"))).toBe(true);
    expect(await probeWmctrl("linux", whichFor())).toBe(false);
  });

  it("reports true on darwin / win32 without probing", async () => {
    const never = whichFor();
    expect(await probeWmctrl("darwin", never)).toBe(true);
    expect(await probeWmctrl("win32", never)).toBe(true);
  });
});

describe("probeNotifications (linux)", () => {
  it("is true when notify-send is present", async () => {
    expect(await probeNotifications("linux", whichFor("notify-send"))).toBe(
      true,
    );
  });

  it("is false when notify-send is missing", async () => {
    expect(await probeNotifications("linux", whichFor())).toBe(false);
  });
});
