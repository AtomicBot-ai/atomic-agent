import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfig, resetConfigCache } from "../config/index.js";
import { pushCommand } from "./push-command.js";

let dir: string;
let prior: string | undefined;
let out: string;
let err: string;
const write = (t: string): void => {
  out += t;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "push-cmd-"));
  prior = process.env.ATOMIC_AGENT_STATE_DIR;
  process.env.ATOMIC_AGENT_STATE_DIR = dir;
  resetConfigCache();
  out = "";
  err = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prior === undefined) delete process.env.ATOMIC_AGENT_STATE_DIR;
  else process.env.ATOMIC_AGENT_STATE_DIR = prior;
  resetConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

function savedPush(): Record<string, unknown> {
  const file = JSON.parse(readFileSync(getConfig().paths.userConfigFile, "utf8")) as {
    notifications: { push: Record<string, unknown> };
  };
  return file.notifications.push;
}

describe("atomic-agent push (ATO-1129)", () => {
  it("on mints a random topic, saves it, and warns that ntfy.sh topics are public", async () => {
    expect(await pushCommand(["on"], { write })).toBe(0);
    const push = savedPush();
    expect(push.enabled).toBe(true);
    expect(push.server).toBe("https://ntfy.sh");
    expect(String(push.topic)).toMatch(/^atag-[-_A-Za-z0-9]{24}$/);
    expect(out).toContain(`https://ntfy.sh/${String(push.topic)}`);
    expect(out).toMatch(/public by name/);
  });

  it("a second on keeps the topic; --new-topic and a new server replace it", async () => {
    await pushCommand(["on"], { write });
    const first = savedPush().topic;
    await pushCommand(["on"], { write });
    expect(savedPush().topic).toBe(first);
    await pushCommand(["on", "--new-topic"], { write });
    const second = savedPush().topic;
    expect(second).not.toBe(first);
    await pushCommand(["on", "--server", "https://ntfy.example.com/"], { write });
    expect(savedPush().server).toBe("https://ntfy.example.com");
    expect(savedPush().topic).not.toBe(second);
    expect(out).toMatch(/Pings go to ntfy\.example\.com/);
  });

  it("refuses a server that is not an http(s) URL, and changes nothing", async () => {
    expect(await pushCommand(["on", "--server", "ftp://x"], { write })).toBe(2);
    expect(err).toMatch(/http\(s\) URL/);
    expect(getConfig().notifications.push.enabled).toBe(false);
  });

  it("off keeps the topic for the next on, and status says where pings go", async () => {
    await pushCommand(["on"], { write });
    const topic = savedPush().topic;
    out = "";
    expect(await pushCommand(["status"], { write })).toBe(0);
    expect(out).toMatch(/^push on → https:\/\/ntfy\.sh\//);
    expect(await pushCommand(["off"], { write })).toBe(0);
    expect(savedPush()).toMatchObject({ enabled: false, topic });
    out = "";
    await pushCommand(["status"], { write });
    expect(out).toMatch(/push off \(topic kept/);
  });

  it("test sends one ping when on and exits 1 with the reason when off", async () => {
    expect(await pushCommand(["test"], { write })).toBe(1);
    expect(err).toMatch(/push is off/);
    await pushCommand(["on"], { write });
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect(await pushCommand(["test"], { write, fetchImpl })).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(out).toContain("test ping sent");
  });

  it("prints help, and returns 2 for nothing or an unknown command", async () => {
    expect(await pushCommand(["--help"], { write })).toBe(0);
    expect(out).toContain("Usage: atomic-agent push");
    expect(await pushCommand([], { write })).toBe(2);
    expect(await pushCommand(["louder"], { write })).toBe(2);
  });
});
