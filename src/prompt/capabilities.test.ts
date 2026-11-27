import { describe, expect, it } from "vitest";

import {
  buildCapabilities,
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

describe("the agent's own e-mail address", () => {
  it("is advertised only when an inbox exists, and reads as a tool hint", async () => {
    const { buildCapabilities } = await import("./capabilities.js");
    const { formatCapabilities } = await import("./stable-prefix.js");
    const without = await buildCapabilities({
      workingDir: "/w",
      browserChannel: "chrome",
    });
    expect(without.emailAddress).toBeUndefined();
    expect(formatCapabilities(without)).not.toMatch(/email:/);
    const withInbox = await buildCapabilities({
      workingDir: "/w",
      browserChannel: "chrome",
      emailAddress: "atag-1@atomicmail.ai",
    });
    expect(formatCapabilities(withInbox)).toContain(
      "email: atag-1@atomicmail.ai (os.email.inbox / os.email.send)",
    );
  });
});

/** ATO-1721: the machine line is probed once with the other capabilities. */
describe("buildCapabilities machine line", () => {
  const base = { workingDir: "/w", browserChannel: "chrome" };
  const probeInput = { dataDir: "/models", platform: "win32" as const, cpuModel: "Intel Core i5-8250U", osName: "Windows 10" };

  it("carries the probed line", async () => {
    const caps = await buildCapabilities({
      ...base,
      machineProbe: { ...probeInput, probe: async () => ({ ramGb: 16, gpuBudgetGb: null, freeDiskGb: 50, cpuOnly: true }) },
    });
    expect(caps.machine).toBe("16 GB RAM, Intel Core i5-8250U, no GPU, Windows 10");
  });

  it("has no machine field without a probe or when the probe fails", async () => {
    expect(await buildCapabilities(base)).not.toHaveProperty("machine");
    const failed = await buildCapabilities({
      ...base,
      machineProbe: { ...probeInput, probe: async () => { throw new Error("no engine"); } },
    });
    expect(failed).not.toHaveProperty("machine");
  });
});
