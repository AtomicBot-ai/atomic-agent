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
} from "./models-share-command.js";
import { modelShareNotice } from "./serve-model-share-notice.js";

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
