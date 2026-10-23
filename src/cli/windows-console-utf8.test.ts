import { describe, expect, it, vi } from "vitest";
import {
  ensureUtf8Console,
  parseCodePage,
  type ConsoleCodePageHost,
} from "./windows-console-utf8.js";

function host(
  overrides: Partial<ConsoleCodePageHost> = {},
  current = "Active code page: 866\r\n",
): ConsoleCodePageHost & { calls: string[][]; exitHandlers: Array<() => void> } {
  const calls: string[][] = [];
  const exitHandlers: Array<() => void> = [];
  return {
    platform: "win32",
    stdoutIsTTY: true,
    runChcp: (args) => {
      calls.push([...args]);
      return args.length === 0 ? current : "";
    },
    onExit: (handler) => exitHandlers.push(handler),
    ...overrides,
    calls,
    exitHandlers,
  };
}

describe("parseCodePage", () => {
  it("reads the number from localized chcp output", () => {
    expect(parseCodePage("Active code page: 866\r\n")).toBe("866");
    expect(parseCodePage("Aktive Codepage: 850.\r\n")).toBe("850");
    expect(parseCodePage("Текущая кодовая страница: 866\r\n")).toBe("866");
  });

  it("returns undefined when there is no number", () => {
    expect(parseCodePage("")).toBeUndefined();
  });
});

describe("ensureUtf8Console", () => {
  it("switches a Windows console to UTF-8 and restores the original page on exit", () => {
    const h = host();
    expect(ensureUtf8Console(h)).toBe(true);
    expect(h.calls).toEqual([[], ["65001"]]);
    expect(h.exitHandlers).toHaveLength(1);
    h.exitHandlers[0]!();
    expect(h.calls.at(-1)).toEqual(["866"]);
  });

  it.each(["darwin", "linux"] as const)("does nothing on %s", (platform) => {
    const runChcp = vi.fn(() => "");
    const h = host({ platform, runChcp });
    expect(ensureUtf8Console(h)).toBe(false);
    expect(runChcp).not.toHaveBeenCalled();
    expect(h.exitHandlers).toHaveLength(0);
  });

  it("does nothing when stdout is not a console (a pipe from the desktop app)", () => {
    const runChcp = vi.fn(() => "");
    const h = host({ stdoutIsTTY: false, runChcp });
    expect(ensureUtf8Console(h)).toBe(false);
    expect(runChcp).not.toHaveBeenCalled();
  });

  it("leaves a console that is already UTF-8 alone and registers no restore", () => {
    const h = host({}, "Active code page: 65001\r\n");
    expect(ensureUtf8Console(h)).toBe(false);
    expect(h.calls).toEqual([[]]);
    expect(h.exitHandlers).toHaveLength(0);
  });

  it("starts anyway when chcp cannot be read", () => {
    const h = host({
      runChcp: () => {
        throw new Error("chcp.com not found");
      },
    });
    expect(ensureUtf8Console(h)).toBe(false);
    expect(h.exitHandlers).toHaveLength(0);
  });

  it("starts anyway when the code page cannot be changed, and registers no restore", () => {
    const calls: string[][] = [];
    const h = host({
      runChcp: (args) => {
        calls.push([...args]);
        if (args.length > 0) throw new Error("access denied");
        return "Active code page: 437\r\n";
      },
    });
    expect(ensureUtf8Console(h)).toBe(false);
    expect(calls).toEqual([[], ["65001"]]);
    expect(h.exitHandlers).toHaveLength(0);
  });

  it("swallows a failed restore on exit", () => {
    let switched = false;
    const h = host({
      runChcp: (args) => {
        if (args.length === 0) return "Active code page: 866\r\n";
        if (!switched) {
          switched = true;
          return "";
        }
        throw new Error("console closed");
      },
    });
    expect(ensureUtf8Console(h)).toBe(true);
    expect(() => h.exitHandlers[0]!()).not.toThrow();
  });
});
