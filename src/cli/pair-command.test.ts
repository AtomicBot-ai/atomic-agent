import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizePairingCode } from "../http/device-code.js";
import { readDevices, redeemPairing, redeemPairingCode } from "../http/device-store.js";
import { pairCommand, parsePairArgs, type PairCommandDeps } from "./pair-command.js";
import { REMOTE_WARNING } from "./pair-remote.js";
import type { ServeRecord } from "./serve-reaper.js";

/** ATO-2308: `atag pair`, its QR link, `--list`, `--revoke` and `--remote`. */
let dir: string;
let out: string[];
let err: string[];
let events: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atag-pair-cmd-"));
  out = [];
  err = [];
  events = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const serveOn = (host: string): ServeRecord => ({
  pid: 42, bootPpid: 1, daemon: true, host, port: 8787, cwd: "/tmp", startedAt: "2026-11-27T10:00:00.000Z", strongKey: true,
});

function deps(host = "0.0.0.0", extra: Partial<PairCommandDeps> = {}): PairCommandDeps {
  return {
    write: (t) => { out.push(t); events.push(`out:${t}`); },
    writeErr: (t) => { err.push(t); events.push(`err:${t}`); },
    stateDir: () => dir,
    serveRecords: () => [serveOn(host)],
    isAlive: () => true,
    lanUrls: () => ["http://192.168.1.20:8787"],
    renderQr: async (text) => `[QR ${text}]`,
    ...extra,
  };
}

function printedToken(): string {
  const match = /\/pair\/([A-Za-z0-9_-]{43})/.exec(out.join(""));
  if (!match?.[1]) throw new Error("no link printed");
  return match[1];
}

describe("atag pair", () => {
  it("prints a QR and a one-time link to serve's LAN address", async () => {
    expect(await pairCommand([], deps())).toBe(0);
    const text = out.join("");
    expect(text).toContain("[QR http://192.168.1.20:8787/pair/");
    expect(text).toContain("works once, for 5 minutes");
    // The printed token is a real pending link: it redeems once.
    expect(redeemPairing(dir, printedToken(), "iPhone").ok).toBe(true);
    expect(redeemPairing(dir, printedToken(), "iPhone").ok).toBe(false);
  });

  it("prints the short code for /panel/pair too, and it redeems the same pairing (ATO-2494)", async () => {
    expect(await pairCommand([], deps())).toBe(0);
    const text = out.join("");
    const match = /type this code at http:\/\/192\.168\.1\.20:8787\/panel\/pair .*: ([A-Z]{4}-[A-Z]{4})/.exec(text);
    expect(match?.[1]).toBeTruthy();
    const code = normalizePairingCode(match?.[1] ?? "");
    expect(code).not.toBeNull();
    expect(redeemPairingCode(dir, code ?? "", "iPhone").ok).toBe(true);
    // One pairing: the code spent it, so the QR link is gone as well.
    expect(redeemPairing(dir, printedToken(), "iPhone").ok).toBe(false);
  });

  it("refuses when serve listens on loopback only, and makes no link", async () => {
    expect(await pairCommand([], deps("127.0.0.1"))).toBe(1);
    expect(err.join("")).toContain("--host 0.0.0.0");
    const read = readDevices(dir);
    expect(read.ok && read.data.pairings).toEqual([]);
  });

  it("--list shows paired devices, --revoke signs one out", async () => {
    await pairCommand([], deps());
    const redeemed = redeemPairing(dir, printedToken(), "iPhone");
    if (!redeemed.ok) throw new Error("redeem failed");
    out = [];
    expect(await pairCommand(["--list"], deps())).toBe(0);
    expect(out.join("")).toContain(`${redeemed.device.id}  iPhone`);
    // ATO-2758: no raw ISO stamps in the list.
    expect(out.join("")).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(out.join("")).toContain("last seen just now");
    expect(await pairCommand(["--revoke", redeemed.device.id], deps())).toBe(0);
    const read = readDevices(dir);
    expect(read.ok && read.data.devices).toEqual([]);
    expect(await pairCommand(["--revoke", redeemed.device.id], deps())).toBe(1);
  });

  it("--remote prints the warning before it starts cloudflared, and closes the tunnel at the end", async () => {
    let stopped = false;
    const code = await pairCommand(["--remote"], deps("127.0.0.1", {
      tunnel: {
        findBinary: () => "/usr/local/bin/cloudflared",
        start: (options) => {
          events.push(`start:${options.originUrl}`);
          return {
            publicUrl: Promise.resolve("https://quiet-fox.trycloudflare.com"),
            recentLog: () => [],
            stop: async () => { stopped = true; },
          };
        },
      },
      waitForStop: async () => { events.push("wait"); },
    }));
    expect(code).toBe(0);
    const warnAt = events.findIndex((e) => e === `err:${REMOTE_WARNING}`);
    const startAt = events.findIndex((e) => e.startsWith("start:"));
    expect(warnAt).toBeGreaterThanOrEqual(0);
    expect(warnAt).toBeLessThan(startAt);
    expect(events[startAt]).toBe("start:http://127.0.0.1:8787");
    expect(out.join("")).toContain("[QR https://quiet-fox.trycloudflare.com/pair/");
    expect(stopped).toBe(true);
  });

  it("--remote refuses a short serve key before the warning and never starts cloudflared", async () => {
    let started = false;
    const code = await pairCommand(["--remote"], deps("127.0.0.1", {
      serveRecords: () => [{ ...serveOn("127.0.0.1"), strongKey: false }],
      tunnel: {
        findBinary: () => { started = true; return "/usr/local/bin/cloudflared"; },
        start: () => { started = true; throw new Error("must not start"); },
      },
      waitForStop: async () => {},
    }));
    expect(code).toBe(1);
    expect(started).toBe(false);
    expect(err.join("")).toContain("shorter than 16 characters");
    expect(err.join("")).not.toContain(REMOTE_WARNING);
    const read = readDevices(dir);
    expect(read.ok && read.data.pairings).toEqual([]);
  });

  it("--remote without cloudflared says how to install it and opens nothing", async () => {
    const code = await pairCommand(["--remote"], deps("0.0.0.0", { tunnel: { findBinary: () => null, platform: "darwin" } }));
    expect(code).toBe(1);
    expect(err.join("")).toContain("needs cloudflared");
    // ATO-2758: the hint is for this command and this OS, not "run serve again".
    expect(err.join("")).toContain("brew install cloudflared");
    expect(err.join("")).toContain("run atag pair --remote again");
    expect(err.join("")).not.toContain("serve again");
    const read = readDevices(dir);
    expect(read.ok && read.data.pairings).toEqual([]);
  });
});

describe("parsePairArgs", () => {
  it("reads the modes and refuses mixing them", () => {
    expect(parsePairArgs([])).toEqual({ mode: "pair", remote: false, url: null });
    expect(parsePairArgs(["--url", "http://x:1"])).toEqual({ mode: "pair", remote: false, url: "http://x:1" });
    expect(parsePairArgs(["--revoke", "all"])).toEqual({ mode: "revoke", id: "all" });
    expect(parsePairArgs(["--list", "--remote"])).toHaveProperty("error");
    expect(parsePairArgs(["--revoke"])).toHaveProperty("error");
    expect(parsePairArgs(["--bogus"])).toHaveProperty("error");
  });
});
