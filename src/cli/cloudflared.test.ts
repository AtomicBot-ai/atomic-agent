import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  CLOUDFLARED_INSTALL_HINT,
  cloudflaredArgs,
  findOnPath,
  normalizeTunnelHostname,
  parseQuickTunnelUrl,
  startCloudflared,
  type SpawnLike,
} from "./cloudflared.js";

/** A stand-in child: stdout/stderr streams, and kill() that exits it unless told to hang. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  constructor(private readonly ignoreTerm = false) {
    super();
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === "SIGTERM" && this.ignoreTerm) return true;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

function fakeSpawn(child: FakeChild): { spawn: SpawnLike; calls: Array<{ command: string; args: readonly string[] }> } {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const spawn: SpawnLike = (command, args) => {
    calls.push({ command, args });
    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

describe("parseQuickTunnelUrl", () => {
  it("finds the trycloudflare address in cloudflared's banner", () => {
    const log = [
      "2026-11-12T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...",
      "2026-11-12T10:00:01Z INF +--------------------------------------------------------------------------------------------+",
      "2026-11-12T10:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
      "2026-11-12T10:00:01Z INF |  https://quiet-river-lamp-orbit.trycloudflare.com                                          |",
    ].join("\n");
    expect(parseQuickTunnelUrl(log)).toBe("https://quiet-river-lamp-orbit.trycloudflare.com");
  });

  it("ignores api.trycloudflare.com in an error line, and text without an address", () => {
    expect(
      parseQuickTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp'),
    ).toBeNull();
    expect(parseQuickTunnelUrl("INF Requesting new quick Tunnel on trycloudflare.com...")).toBeNull();
    expect(parseQuickTunnelUrl("http://plain-http.trycloudflare.com")).toBeNull();
  });

  it("lowercases and does not swallow trailing text", () => {
    expect(parseQuickTunnelUrl("at HTTPS://Abc-Def.TryCloudflare.com/path |")).toBe("https://abc-def.trycloudflare.com");
  });
});

describe("cloudflaredArgs", () => {
  it("points a quick tunnel at the given origin, without auto-update", () => {
    expect(cloudflaredArgs({ mode: "quick" }, "http://127.0.0.1:5555")).toEqual([
      "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:5555",
    ]);
  });

  it("runs a named tunnel against the same origin", () => {
    expect(
      cloudflaredArgs({ mode: "named", name: "hooks", hostname: "hooks.example.com" }, "http://127.0.0.1:5555"),
    ).toEqual(["tunnel", "--no-autoupdate", "run", "--url", "http://127.0.0.1:5555", "hooks"]);
  });
});

describe("normalizeTunnelHostname", () => {
  it("accepts a hostname with or without scheme and slash", () => {
    expect(normalizeTunnelHostname("Hooks.Example.com")).toBe("hooks.example.com");
    expect(normalizeTunnelHostname("https://hooks.example.com/")).toBe("hooks.example.com");
  });
  it("refuses paths, ports and garbage", () => {
    expect(normalizeTunnelHostname("hooks.example.com/api")).toBeNull();
    expect(normalizeTunnelHostname("hooks.example.com:8443")).toBeNull();
    expect(normalizeTunnelHostname("localhost")).toBeNull();
    expect(normalizeTunnelHostname("")).toBeNull();
  });
});

describe("findOnPath", () => {
  it("returns the first executable match and never anything off PATH", () => {
    const exec = new Set(["/opt/b/cloudflared"]);
    expect(findOnPath("cloudflared", { PATH: "/opt/a:/opt/b" }, "darwin", (p) => exec.has(p))).toBe("/opt/b/cloudflared");
    expect(findOnPath("cloudflared", { PATH: "/opt/a" }, "darwin", (p) => exec.has(p))).toBeNull();
    expect(findOnPath("cloudflared", {}, "darwin", () => true)).toBeNull();
  });

  it("tries PATHEXT on Windows", () => {
    const hit = "C:\\Tools\\cloudflared.exe";
    expect(
      findOnPath("cloudflared", { Path: "C:\\Tools", PATHEXT: ".EXE;.CMD" }, "win32", (p) => p === hit),
    ).toBe(hit);
  });

  it("the install hint never offers to download", () => {
    expect(CLOUDFLARED_INSTALL_HINT).toContain("brew install cloudflared");
    expect(CLOUDFLARED_INSTALL_HINT).toContain("never downloads");
  });
});

describe("startCloudflared", () => {
  it("spawns the binary, resolves the quick URL from stderr and stops it with SIGTERM", async () => {
    const child = new FakeChild();
    const { spawn, calls } = fakeSpawn(child);
    const handle = startCloudflared({
      binary: "/usr/local/bin/cloudflared",
      request: { mode: "quick" },
      originUrl: "http://127.0.0.1:4444",
      spawn,
    });
    expect(calls).toEqual([
      { command: "/usr/local/bin/cloudflared", args: ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:4444"] },
    ]);
    child.stderr.write("INF |  https://some-words-here.trycloudflare.com  |\n");
    await expect(handle.publicUrl).resolves.toBe("https://some-words-here.trycloudflare.com");
    await handle.stop();
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when cloudflared ignores SIGTERM", async () => {
    const child = new FakeChild(true);
    const { spawn } = fakeSpawn(child);
    const handle = startCloudflared({
      binary: "cloudflared",
      request: { mode: "quick" },
      originUrl: "http://127.0.0.1:1",
      spawn,
      urlTimeoutMs: 5,
      killGraceMs: 5,
    });
    await handle.stop();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("resolves null on timeout, and on an early exit", async () => {
    const slow = new FakeChild();
    const timedOut = startCloudflared({
      binary: "cloudflared", request: { mode: "quick" }, originUrl: "http://127.0.0.1:1",
      spawn: fakeSpawn(slow).spawn, urlTimeoutMs: 5,
    });
    await expect(timedOut.publicUrl).resolves.toBeNull();
    await timedOut.stop();

    const dying = new FakeChild();
    const onExit = vi.fn();
    const early = startCloudflared({
      binary: "cloudflared", request: { mode: "quick" }, originUrl: "http://127.0.0.1:1",
      spawn: fakeSpawn(dying).spawn, onExit,
    });
    dying.stderr.write("ERR failed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\"\n");
    dying.emit("exit", 1, null);
    await expect(early.publicUrl).resolves.toBeNull();
    expect(onExit).toHaveBeenCalledWith(1, null);
    expect(early.recentLog().join("\n")).toContain("failed to request quick Tunnel");
    await early.stop();
    expect(dying.signals).toEqual([]);
  });

  it("a named tunnel is up at its hostname once a connection registers", async () => {
    const child = new FakeChild();
    const handle = startCloudflared({
      binary: "cloudflared",
      request: { mode: "named", name: "hooks", hostname: "hooks.example.com" },
      originUrl: "http://127.0.0.1:1",
      spawn: fakeSpawn(child).spawn,
    });
    child.stderr.write("INF Registered tunnel connection connIndex=0 location=ams01\n");
    await expect(handle.publicUrl).resolves.toBe("https://hooks.example.com");
    await handle.stop();
  });
});
