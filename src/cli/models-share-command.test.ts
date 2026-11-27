import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readUserConfigFileSync } from "../config/config-file.js";
import {
  formatShareSummary,
  parseShareArgs,
  setModelShareEnabled,
  shareBaseUrls,
  shareJson,
} from "./models-share-command.js";
import { resolveShareReach } from "./models-share-reach.js";
import type { ServeRecord } from "./serve-reaper.js";
import { modelShareNotice } from "./serve-model-share-notice.js";

const serveOn = (host: string, port = 8787, pid = 42): ServeRecord => ({
  pid, bootPpid: 1, daemon: true, host, port, cwd: "/tmp", startedAt: "2026-11-27T10:00:00.000Z", strongKey: true,
});
const urls = { local: "http://127.0.0.1:8787/raw/v1", lan: ["http://192.168.1.5:8787/raw/v1"] };

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

  it("parses --local and --network, and refuses both together or with --off (ATO-2483)", () => {
    expect(parseShareArgs(["--network"])).toMatchObject({ where: "network", off: false });
    expect(parseShareArgs(["--local"])).toMatchObject({ where: "local" });
    expect(parseShareArgs([])).not.toHaveProperty("where");
    expect(parseShareArgs(["--local", "--network"])).toHaveProperty("error");
    expect(parseShareArgs(["--off", "--network"])).toHaveProperty("error");
  });

  it("says how other devices reach it in network mode instead of asking for --host", () => {
    const text = formatShareSummary({ key: "k".repeat(64), urls: { local: "http://127.0.0.1:8787/raw/v1", lan: [] }, rotated: false, network: true });
    expect(text).not.toContain("--host 0.0.0.0");
    expect(text).toContain("plain http");
  });

  it("gives /raw/v1 base URLs for this computer and each LAN address", () => {
    expect(shareBaseUrls(8787, ["http://192.168.1.5:8787"])).toEqual({
      local: "http://127.0.0.1:8787/raw/v1",
      lan: ["http://192.168.1.5:8787/raw/v1"],
    });
  });

  it("prints the URL, the key and the plain-http warning", () => {
    const text = formatShareSummary({
      key: "k".repeat(64),
      urls: { local: "http://127.0.0.1:8787/raw/v1", lan: ["http://192.168.1.5:8787/raw/v1"] },
      rotated: false,
    });
    expect(text).toContain("http://127.0.0.1:8787/raw/v1");
    expect(text).toContain("http://192.168.1.5:8787/raw/v1");
    expect(text).toContain("k".repeat(64));
    expect(text).toContain("plain http");
    // ATO-2483: local mode refuses other devices even on a serve on 0.0.0.0, so --network is the one way.
    expect(text).toContain("models share --network");
    expect(text).not.toContain("--host 0.0.0.0");
  });

  it("no serve running: switched on, but nothing answers yet (ATO-2758)", () => {
    const reach = resolveShareReach({ records: [serveOn("127.0.0.1")], isAlive: () => false, mode: "local", port: 8787, urls });
    expect(reach.listening).toBe(false);
    const text = formatShareSummary({ key: "k".repeat(64), urls: reach.urls, rotated: false, listening: reach.listening });
    expect(text).toContain("but nothing answers yet");
    expect(text).toContain("Start it with: atomic-agent serve");
    expect(text).not.toContain("Model sharing is on.");
    expect(shareJson("k", reach, "/s/key")).toMatchObject({ listening: false, mode: "local" });
    const live = resolveShareReach({ records: [serveOn("127.0.0.1")], isAlive: () => true, mode: "local", port: 8787, urls });
    expect(formatShareSummary({ key: "k", urls: live.urls, rotated: false, listening: live.listening })).toContain("Model sharing is on.");
  });

  it("LAN addresses only for --network; --local says only this computer can reach it (ATO-2758)", () => {
    // A serve on 0.0.0.0 does not open the share to other devices in local mode (ATO-2483).
    const local = resolveShareReach({ records: [serveOn("0.0.0.0")], isAlive: () => true, mode: "local", port: 8787, urls });
    expect(local.urls.lan).toEqual([]);
    const localText = formatShareSummary({ key: "k", urls: local.urls, rotated: false, listening: true });
    expect(localText).not.toContain("192.168.1.5");
    expect(localText).toContain("Only this computer can reach it");
    const network = resolveShareReach({ records: [serveOn("127.0.0.1")], isAlive: () => true, mode: "network", port: 8787, urls });
    const networkText = formatShareSummary({ key: "k", urls: network.urls, rotated: false, network: true, listening: true });
    expect(networkText).toContain("Base URL, other devices:   http://192.168.1.5:8787/raw/v1");
    expect(networkText).not.toContain("Only this computer");
  });

  it("says serve's --api-key guards the agent, not the model share (ATO-2758)", () => {
    const text = formatShareSummary({ key: "k".repeat(64), urls, rotated: false, network: true });
    expect(text).toContain("serve's own --api-key is another key: it guards the agent itself");
    expect(text).toContain("the other app does not need it");
    expect(text).not.toContain("<a key you choose>");
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
