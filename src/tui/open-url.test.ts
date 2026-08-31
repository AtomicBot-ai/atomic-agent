import { describe, expect, it, vi } from "vitest";
import type { SpawnedTerminal, TerminalSpawn } from "./open-terminal-window.js";
import {
  buildOpenUrlCommand,
  canonicalHttpUrl,
  openUrlInBrowser,
} from "./open-url.js";

/** Child stub that replays one lifecycle event — as in `open-terminal-window.test.ts`. */
function fakeChild(event: "error" | "exit" | "none", payload?: Error | number) {
  const unref = vi.fn();
  const child: SpawnedTerminal = {
    once(name: string, listener: (...args: never[]) => void) {
      if (name === event) {
        queueMicrotask(() =>
          (listener as unknown as (arg?: Error | number) => void)(payload),
        );
      }
      return child;
    },
    unref,
  };
  return { child, unref };
}

describe("buildOpenUrlCommand", () => {
  it("uses `open` on darwin", () => {
    expect(buildOpenUrlCommand("https://example.com/docs", "darwin")).toEqual({
      cmd: "open",
      args: ["https://example.com/docs"],
      label: "default browser",
    });
  });

  it("uses `xdg-open` on linux", () => {
    expect(buildOpenUrlCommand("https://example.com/docs", "linux")).toEqual({
      cmd: "xdg-open",
      args: ["https://example.com/docs"],
      label: "default browser",
    });
  });

  it("falls back to `xdg-open` on the BSDs", () => {
    expect(buildOpenUrlCommand("https://a.io/", "freebsd")?.cmd).toBe(
      "xdg-open",
    );
  });

  it("quotes the whole start line verbatim on win32", () => {
    // The URL rides inside double quotes so cmd.exe cannot read `&` as
    // a command separator — the query below must arrive intact.
    const launch = buildOpenUrlCommand(
      "https://example.com/search?a=1&b=2",
      "win32",
    );
    expect(launch).toEqual({
      cmd: "cmd.exe",
      args: ["/c", 'start "" "https://example.com/search?a=1&b=2"'],
      label: "default browser",
      windowsVerbatimArguments: true,
    });
  });

  it("refuses non-http(s) schemes outright", () => {
    expect(buildOpenUrlCommand("file:///etc/passwd", "darwin")).toBeNull();
    expect(buildOpenUrlCommand("javascript:alert(1)", "linux")).toBeNull();
    expect(buildOpenUrlCommand("vscode://open", "win32")).toBeNull();
    expect(buildOpenUrlCommand("not a url at all", "darwin")).toBeNull();
  });
});

describe("canonicalHttpUrl", () => {
  it("accepts http and https and re-serialises canonically", () => {
    expect(canonicalHttpUrl("https://example.com")).toBe(
      "https://example.com/",
    );
    expect(canonicalHttpUrl("http://a.io/x")).toBe("http://a.io/x");
  });

  it("percent-encodes double quotes so cmd quoting cannot be broken", () => {
    const href = canonicalHttpUrl('https://a.io/pa"th');
    expect(href).not.toBeNull();
    expect(href).not.toContain('"');
    expect(href).toContain("%22");
  });

  it("returns null for other schemes and for garbage", () => {
    expect(canonicalHttpUrl("file:///tmp/x")).toBeNull();
    expect(canonicalHttpUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalHttpUrl("")).toBeNull();
  });
});

describe("openUrlInBrowser", () => {
  it("spawns the opener detached and reports ok on exit 0", async () => {
    const { child, unref } = fakeChild("exit", 0);
    const spawn = vi.fn(() => child) as unknown as TerminalSpawn;
    const result = await openUrlInBrowser("https://example.com/", {
      platform: "darwin",
      spawn,
    });
    expect(result).toEqual({ ok: true, label: "default browser" });
    expect(spawn).toHaveBeenCalledWith("open", ["https://example.com/"], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-http(s) URL without spawning anything", async () => {
    const spawn = vi.fn() as unknown as TerminalSpawn;
    const result = await openUrlInBrowser("file:///etc/passwd", {
      platform: "linux",
      spawn,
    });
    expect(result).toEqual({
      ok: false,
      reason: "not an http(s) URL: file:///etc/passwd",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns a missing opener as a reason instead of throwing", async () => {
    const { child } = fakeChild(
      "error",
      new Error("spawn xdg-open ENOENT"),
    );
    const spawn = vi.fn(() => child) as unknown as TerminalSpawn;
    const result = await openUrlInBrowser("https://a.io/", {
      platform: "linux",
      spawn,
    });
    expect(result).toEqual({
      ok: false,
      reason: "xdg-open: spawn xdg-open ENOENT",
    });
  });

  it("survives a synchronous throw from spawn", async () => {
    const spawn = vi.fn(() => {
      throw new Error("EACCES");
    }) as unknown as TerminalSpawn;
    const result = await openUrlInBrowser("https://a.io/", {
      platform: "darwin",
      spawn,
    });
    expect(result).toEqual({ ok: false, reason: "open: EACCES" });
  });
});
