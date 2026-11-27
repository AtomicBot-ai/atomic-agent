import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readUserConfigFileSync } from "../config/config-file.js";
import {
  formatShareSummary,
  parseShareArgs,
  setModelShareEnabled,
  shareJson,
} from "./models-share-command.js";
import { resolveShareReach } from "./models-share-reach.js";
import type { ServeRecord } from "./serve-reaper.js";
import { modelShareNotice } from "./serve-model-share-notice.js";

const serveOn = (host: string, port = 8787, pid = 42): ServeRecord => ({
  pid, bootPpid: 1, daemon: true, host, port, cwd: "/tmp", startedAt: "2026-11-27T10:00:00.000Z", strongKey: true,
});
const lan = () => ["http://192.168.1.5:8787"];

/** ATO-2336: `atomic-agent models share` and serve's start line about it. */
describe("models share", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "models-share-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses --rotate, --off, --port and --json, and refuses --off with --rotate", () => {
    expect(parseShareArgs([])).toEqual({ off: false, rotate: false, port: null, json: false });
    expect(parseShareArgs(["--rotate", "--port", "9000", "--json"])).toEqual({ off: false, rotate: true, port: 9000, json: true });
    expect(parseShareArgs(["--off"])).toMatchObject({ off: true });
    expect(parseShareArgs(["--off", "--rotate"])).toHaveProperty("error");
    expect(parseShareArgs(["--port", "0"])).toHaveProperty("error");
    expect(parseShareArgs(["--nope"])).toHaveProperty("error");
  });

  it("serve on the network: /raw/v1 for this computer and each LAN address, and the plain-http warning", () => {
    const reach = resolveShareReach({ records: [serveOn("0.0.0.0")], isAlive: () => true, port: null, lanUrls: lan });
    expect(reach).toEqual({
      kind: "network",
      port: 8787,
      local: "http://127.0.0.1:8787/raw/v1",
      lan: ["http://192.168.1.5:8787/raw/v1"],
    });
    const text = formatShareSummary({ key: "k".repeat(64), reach, rotated: false });
    expect(text).toContain("Model sharing is on.");
    expect(text).toContain("http://127.0.0.1:8787/raw/v1");
    expect(text).toContain("Base URL, other devices:   http://192.168.1.5:8787/raw/v1");
    expect(text).toContain("k".repeat(64));
    expect(text).toContain("plain http");
    // Already on the network: no advice to restart it with another key.
    expect(text).not.toContain("--api-key");
  });

  it("serve on this computer only: no LAN addresses, and the network key is explained (ATO-2758)", () => {
    const reach = resolveShareReach({ records: [serveOn("127.0.0.1")], isAlive: () => true, port: null, lanUrls: lan });
    expect(reach.kind).toBe("local");
    const text = formatShareSummary({ key: "k".repeat(64), reach, rotated: false });
    expect(text).not.toContain("192.168.1.5");
    expect(text).not.toContain("other devices:");
    expect(text).toContain("serve listens on this computer only");
    expect(text).toContain("--host 0.0.0.0");
    expect(text).toContain("not the key above");
    expect(text).not.toContain("a key you choose>");
  });

  it("no serve running: says so instead of claiming sharing works (ATO-2758)", () => {
    const reach = resolveShareReach({ records: [serveOn("0.0.0.0")], isAlive: () => false, port: null, lanUrls: lan });
    expect(reach).toEqual({ kind: "stopped", port: 8787, local: "http://127.0.0.1:8787/raw/v1" });
    const text = formatShareSummary({ key: "k".repeat(64), reach, rotated: false });
    expect(text).toContain("serve is not running");
    expect(text).toContain("Start it with: atomic-agent serve");
    expect(text).not.toContain("Model sharing is on.");
    expect(text).not.toContain("192.168.1.5");
    expect(shareJson("k", reach, "/s/key")).toMatchObject({ serving: null, urls: { lan: [] } });
  });

  it("uses the running serve's port, and --port picks among several", () => {
    const records = [serveOn("127.0.0.1", 9100, 1), serveOn("0.0.0.0", 8787, 2)];
    const mine = resolveShareReach({ records: [serveOn("127.0.0.1", 9100)], isAlive: () => true, port: null });
    expect(mine.local).toBe("http://127.0.0.1:9100/raw/v1");
    const picked = resolveShareReach({ records, isAlive: () => true, port: 9100, lanUrls: lan });
    expect(picked).toMatchObject({ kind: "local", port: 9100 });
    expect(resolveShareReach({ records, isAlive: () => true, port: 9999 }).kind).toBe("stopped");
  });

  it("writes localModels.managed.share on and off in the config file", () => {
    const path = join(dir, "config.json");
    setModelShareEnabled(path, true);
    expect(readUserConfigFileSync(path)?.localModels.managed.share).toBe(true);
    setModelShareEnabled(path, false);
    expect(readUserConfigFileSync(path)?.localModels.managed.share).toBe(false);
  });

  it("serve says nothing while sharing is off, and warns about plain http beyond loopback", () => {
    expect(modelShareNotice(false, false)).toBe("");
    const local = modelShareNotice(true, true);
    expect(local).toContain("/raw/v1");
    expect(local).not.toContain("plain http");
    expect(modelShareNotice(true, false)).toContain("plain http");
  });
});
