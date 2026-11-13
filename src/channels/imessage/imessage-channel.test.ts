import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImessageChannel, type ImessageChannelDeps } from "./imessage-channel.js";
import { IMSG_AUTOMATION_HINT, IMSG_DISK_ACCESS_HINT, IMSG_INSTALL_HINT } from "./imsg-errors.js";
import type { ExecFileLike } from "./imsg-send.js";
import type { WatchChild } from "./imsg-watch.js";

class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}
class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill = vi.fn(() => true);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "imessage-channel-"));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function make(over: Partial<ImessageChannelDeps> = {}, execFail?: string) {
  const children: FakeChild[] = [];
  const sends: Array<readonly string[]> = [];
  const statuses: Array<{ state: string; lastError?: string }> = [];
  const lock = { acquire: vi.fn(), release: vi.fn() };
  const execFileImpl: ExecFileLike = (_f, args, _o, cb) => {
    sends.push(args);
    if (execFail) cb(new Error("Command failed"), "", execFail);
    else cb(null, "sent", "");
  };
  const channel = new ImessageChannel({
    runtime: {
      runTurn: vi.fn(async (_s: unknown, _t: string, o: { eventHook?: (e: unknown) => void }) =>
        o.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: "ok" } }),
      ),
      createSession: () => ({ id: "s-1", metadata: {} }),
      sessionStore: { load: () => null },
    } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    approvals: { resolve: vi.fn() } as never,
    approvalRouter: { setForSession: vi.fn(() => vi.fn()) } as never,
    enabled: true,
    ownerIds: ["+14155551212"],
    options: {},
    stateDir: dir,
    onStatus: (s) => statuses.push(s),
    lock,
    spawnImpl: () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as WatchChild;
    },
    execFileImpl,
    watchDelayMs: () => 1000,
    ...over,
  });
  return { channel, children, sends, statuses, lock };
}

const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;

describe("ImessageChannel", () => {
  it("stays disabled when switched off or with no owner, and never spawns imsg", async () => {
    const off = make({ enabled: false });
    await off.channel.start();
    expect(off.channel.state()).toBe("disabled");
    const unpaired = make({ ownerIds: [] });
    await unpaired.channel.start();
    expect(unpaired.channel.state()).toBe("disabled");
    expect(unpaired.channel.lastError()).toMatch(/ownerIds/);
    expect(off.children.length + unpaired.children.length).toBe(0);
    expect(unpaired.lock.acquire).not.toHaveBeenCalled();
  });

  it("goes up when the watcher spawns and answers an owner", async () => {
    const t = make();
    await t.channel.start();
    t.children[0]!.emit("spawn");
    expect(t.channel.state()).toBe("up");
    t.children[0]!.stdout.emit(
      "data",
      line({ id: 3, chat_id: 9, chat_guid: "iMessage;-;+14155551212", sender: "+14155551212", is_from_me: false, text: "hi", attachments: [] }),
    );
    await vi.waitFor(() => expect(t.sends).toHaveLength(1));
    expect(t.sends[0]).toEqual(["send", "--to", "+14155551212", "--text=ok"]);
  });

  it("is disabled with an install hint when imsg is missing", async () => {
    const t = make();
    await t.channel.start();
    t.children[0]!.emit("error", Object.assign(new Error("spawn imsg ENOENT"), { code: "ENOENT" }));
    expect(t.channel.state()).toBe("disabled");
    expect(t.channel.lastError()).toBe(IMSG_INSTALL_HINT);
    expect(t.lock.release).toHaveBeenCalled();
  });

  it("is down with the Full Disk Access hint and keeps retrying", async () => {
    const t = make();
    await t.channel.start();
    t.children[0]!.stderr.emit("data", "unable to open database file");
    t.children[0]!.emit("close", 1, null);
    expect(t.channel.state()).toBe("down");
    expect(t.channel.lastError()).toBe(IMSG_DISK_ACCESS_HINT);
    expect(t.statuses.at(-1)).toEqual({ channel: "imessage", state: "down", lastError: IMSG_DISK_ACCESS_HINT });
    vi.advanceTimersByTime(1000);
    expect(t.children).toHaveLength(2);
    t.children[1]!.emit("spawn");
    expect(t.channel.state()).toBe("up");
  });

  it("is down with the Automation hint when a send is refused", async () => {
    const t = make({}, "Not authorized to send Apple events to Messages. (-1743)");
    await t.channel.start();
    t.children[0]!.emit("spawn");
    t.children[0]!.stdout.emit(
      "data",
      line({ id: 3, chat_id: 9, chat_guid: "iMessage;-;+14155551212", sender: "+14155551212", is_from_me: false, text: "/status", attachments: [] }),
    );
    await vi.waitFor(() => expect(t.channel.state()).toBe("down"));
    expect(t.channel.lastError()).toBe(IMSG_AUTOMATION_HINT);
  });

  it("goes down when another process holds the lock", async () => {
    const t = make({
      lock: {
        acquire: () => {
          throw new Error("channel-locked: already running in another atomic-agent (pid 42)");
        },
        release: vi.fn(),
      },
    });
    await t.channel.start();
    expect(t.channel.state()).toBe("down");
    expect(t.channel.lastError()).toMatch(/^channel-locked:/);
    expect(t.children).toHaveLength(0);
  });

  it("reports bad options as down instead of guessing", async () => {
    const t = make({ options: { allowGroups: "yes" } });
    await t.channel.start();
    expect(t.channel.state()).toBe("down");
    expect(t.channel.lastError()).toMatch(/allowGroups/);
  });

  it("stop() kills the watcher, releases the lock, is idempotent and allows a restart", async () => {
    const t = make();
    await t.channel.start();
    await t.channel.start();
    expect(t.children).toHaveLength(1);
    await t.channel.stop();
    await t.channel.stop();
    expect(t.children[0]!.kill).toHaveBeenCalledTimes(1);
    expect(t.lock.release).toHaveBeenCalledTimes(1);
    expect(t.channel.state()).toBe("disabled");
    vi.advanceTimersByTime(120_000);
    expect(t.children).toHaveLength(1);
    await t.channel.start();
    expect(t.children).toHaveLength(2);
  });
});
